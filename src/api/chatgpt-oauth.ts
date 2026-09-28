/**
 * ChatGPT OAuth API client.
 *
 * Talks to the ChatGPT/Codex Responses-style endpoint using a bearer token
 * obtained via the Device Authorization Flow (see ../auth/chatgptOAuth.ts).
 *
 * Transport: always `stream: true`. The Codex backend rejects `stream:false`
 * outright with 400 `"Stream must be set to true"`, and the official Codex
 * CLI / other working OAuth-Codex clients never send anything else either.
 * Obsidian's `requestUrl()` buffers the entire SSE response before returning,
 * so we read the final body as text and parse it client-side — no streaming
 * IO required, which keeps mobile compatibility.
 *
 * Conversation continuity is **client-side**: we always send `store: false`
 * (the Codex backend rejects requests without it) and replay the full
 * conversation history into `input` every turn. We deliberately do NOT use
 * `previous_response_id` — it requires the server to persist the previous
 * response, which is incompatible with `store: false`.
 */
import { requestUrl } from "obsidian";
import type {
  ChatSettings,
  UnifiedMessage,
  UnifiedToolDef,
  UnifiedResponse,
  ContentBlock,
} from "../types";
import { CHATGPT_OAUTH_DEFAULT_MODEL } from "../types";
import {
  ChatGPTOAuthError,
  type ChatGPTOAuthService,
} from "../auth/chatgptOAuth";

const CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses";

/**
 * `originator` header value.
 *
 * The Codex backend uses this header to identify which client is calling
 * `/codex/responses`. In practice the value `"opencode"` (the official
 * OpenAI Codex CLI's identifier) is what the backend allows; custom values
 * are rejected with the same generic-looking 400s as malformed bodies.
 *
 * We send `"opencode"` to mirror what the official Codex CLI and other
 * working OAuth-Codex clients send. The user is already authenticated with
 * their own ChatGPT account, so this is purely a client-identity header,
 * not an auth claim.
 */
const ORIGINATOR = "opencode";

/**
 * `User-Agent` we attach to Codex requests.
 *
 * The OpenAI JS SDK that the official Codex CLI uses sends `OpenAI/JS X.Y.Z`.
 * Obsidian's `requestUrl()` doesn't add an OpenAI-flavored UA on its own,
 * so we set one explicitly. This is defensive — the backend may or may not
 * gate on UA, but matching the SDK's shape avoids surprises.
 */
const USER_AGENT = "OpenAI/JS 4.x chatting-with-ai/0.1";

// We deliberately do NOT discover Codex models at runtime. The Codex
// `/codex/models` endpoint either returns the same handful of slugs we
// already hardcode in settings.ts FALLBACK_MODELS["chatgpt-oauth"], or
// returns the chat.com UI catalog (dash-form slugs like `gpt-5-5` that
// `/codex/responses` rejects with HTTP 400). Either way, live discovery
// adds no value over the hardcoded list, which is mirrored from the
// official OpenAI Codex CLI's bundled `models.json`. Users can still pick
// "Custom..." in the settings dropdown to type any slug.

/** Held by main.ts; injected via setChatGPTOAuthService(). */
let oauthService: ChatGPTOAuthService | null = null;

export function setChatGPTOAuthService(service: ChatGPTOAuthService | null): void {
  oauthService = service;
}

/**
 * Reset any per-conversation client state (called from AgentLoop.clear()).
 *
 * The Codex backend forces us into stateless mode, so we don't actually
 * keep any cross-turn server identifiers. This function exists so the
 * agent loop can call it uniformly alongside the OpenAI provider's reset
 * — and so we have one place to add new state if we ever introduce it.
 */
export function clearChatGPTOAuthState(): void {
  /* no-op: history lives entirely in AgentLoop.messages */
}

export async function sendChatGPTOAuthMessage(
  settings: ChatSettings,
  messages: UnifiedMessage[],
  tools: UnifiedToolDef[],
  systemPrompt: string,
): Promise<UnifiedResponse> {
  if (!oauthService) {
    throw new ChatGPTOAuthError(
      "ChatGPT OAuth service is not initialized. Reload the plugin.",
    );
  }

  let credential;
  try {
    credential = await oauthService.getUsableCredential();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new ChatGPTOAuthError(
      `ChatGPT OAuth session expired and refresh failed. Please reconnect your ChatGPT account in settings. (${msg})`,
    );
  }
  if (!credential) {
    throw new ChatGPTOAuthError(
      "ChatGPT OAuth is not connected. Open Settings -> Chatting with AI -> Connect ChatGPT.",
    );
  }

  const model = settings.model || CHATGPT_OAUTH_DEFAULT_MODEL;

  const baseBody: Record<string, unknown> = {
    model,
    // Replay the full conversation each turn — Codex's `store:false` mode
    // makes server-side `previous_response_id` chaining unavailable.
    input: buildFullHistoryInput(messages),
    instructions: systemPrompt,
    // Required by the Codex backend; omitting it returns
    // 400 {"detail":"Store must be set to false"}.
    store: false,
    // Match the request shape used by other working Codex-via-OAuth clients
    // (verified against the OpenAI Codex CLI and external references). These
    // fields aren't strictly documented as required, but Codex's response
    // pipeline expects them and at least one is required for reasoning models.
    parallel_tool_calls: true,
  };

  if (/^o\d/.test(model) || /^gpt-5/.test(model) || /codex/i.test(model)) {
    baseBody.reasoning = { effort: "medium", summary: "auto" };
    // Codex requires the encrypted reasoning payload to be threaded through
    // the request when reasoning is enabled. Without this, the backend
    // sometimes returns 400 on follow-up turns.
    baseBody.include = ["reasoning.encrypted_content"];
  }

  const apiTools: Record<string, unknown>[] = tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
    // Codex backend (and the OpenAI Responses API generally) accepts
    // `strict` on function tools. Setting `false` matches what the
    // official Codex CLI / other working OAuth-Codex clients send and
    // avoids unintended structured-output validation on free-form tools.
    strict: false,
  }));
  if (settings.enableWebSearch) {
    // Codex backend uses the canonical name `web_search` (per
    // openai/codex `codex-rs/tools/src/tool_spec.rs`'s
    // `#[serde(rename = "web_search")]`). The older
    // `web_search_preview` name from the public Responses-API preview
    // is rejected with HTTP 400 `"Unsupported tool type: web_search_preview"`.
    apiTools.push({ type: "web_search" });
  }
  if (apiTools.length > 0) {
    baseBody.tools = apiTools;
  }

  // Codex backend only accepts streaming requests. We always send
  // `stream: true` and parse the buffered SSE body client-side.
  return sendOnce(
    { ...baseBody, stream: true },
    credential.accessToken,
    credential.accountId,
  );
}

async function sendOnce(
  body: Record<string, unknown>,
  accessToken: string,
  accountId: string | undefined,
): Promise<UnifiedResponse> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream, application/json",
    "User-Agent": USER_AGENT,
    originator: ORIGINATOR,
  };
  if (accountId) {
    headers["ChatGPT-Account-Id"] = accountId;
  }

  let response;
  try {
    response = await requestUrl({
      url: CODEX_RESPONSES_URL,
      method: "POST",
      headers,
      body: JSON.stringify(body),
      throw: false,
    });
  } catch (e: unknown) {
    const err = asRecord(e);
    const status = typeof err.status === "number" || typeof err.status === "string" ? String(err.status) : "";
    const message = typeof err.message === "string" ? err.message : String(e);
    throw new ChatGPTOAuthError(
      `ChatGPT OAuth request failed (${status}): ${message}`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new ChatGPTOAuthError(
      `ChatGPT OAuth session rejected by the server (HTTP ${response.status}). Please reconnect your ChatGPT account in settings.`,
    );
  }

  if (response.status < 200 || response.status >= 300) {
    // Codex returns errors as either `{detail: "..."}` (FastAPI-style) or
    // `{error: {message: "..."}}` (OpenAI-style). Extract whichever is
    // present; fall back to the raw body so the cause is never lost.
    // The .json access is wrapped in try/catch because iOS Obsidian's
    // lazy `response.json` getter throws on any non-JSON body — see the
    // long comment in parseResponseBody().
    let json: Record<string, unknown> | undefined;
    try {
      json = asOptionalRecord(response.json);
    } catch {
      json = undefined;
    }
    const detail = json?.detail;
    const detailText =
      typeof detail === "string"
        ? detail
        : getNestedString(detail, ["message"]);
    const apiMsg =
      detailText ??
      getNestedString(json, ["error", "message"]) ??
      response.text?.slice(0, 300) ??
      `HTTP ${response.status}`;
    const err = new ChatGPTOAuthError(
      `ChatGPT OAuth request failed (${response.status}): ${apiMsg}. The Codex backend may not accept the selected model or request format. Try reconnecting, picking a different model, or switching to OpenAI API Key.`,
    );
    (err as Error & { status?: number }).status = response.status;
    throw err;
  }

  // Two possible response shapes:
  //   - JSON object (non-streaming or `response.completed` already aggregated)
  //   - SSE text body (streaming, buffered by requestUrl)
  const data = parseResponseBody(response);
  return fromResponsesOutput(data);
}

function parseResponseBody(response: {
  text?: string;
  json?: unknown;
}): Record<string, unknown> {
  // On iOS Obsidian, `requestUrl()` returns a `response.json` that is a
  // lazy getter calling `JSON.parse(text)` under the hood. When the body
  // is SSE (which is always true for `/codex/responses`), accessing
  // `.json` throws a SyntaxError like
  //   `JSON Parse error: Unexpected identifier "event"`
  // because the text starts with `event: ...`. Desktop Electron returns
  // undefined / null instead of throwing, but mobile is stricter. We
  // wrap the access in try/catch so we always cleanly fall through to
  // the SSE text parser below.
  let jsonObj: Record<string, unknown> | undefined;
  try {
    jsonObj = asOptionalRecord(response.json);
  } catch {
    jsonObj = undefined;
  }
  if (jsonObj && (jsonObj.output || jsonObj.id)) {
    return jsonObj;
  }

  const text = response.text ?? "";
  if (!text) {
    throw new ChatGPTOAuthError("ChatGPT OAuth response was empty.");
  }

  // SSE: lines beginning with `data: ` are JSON events. We need to do
  // **client-side reconstruction** of the response, because Codex's
  // `response.completed` event always has `response.output: []` —
  // unlike the non-streaming Responses API on `api.openai.com`, the
  // Codex backend never aggregates the final output server-side.
  //
  // Strategy:
  //   1. Walk every event in order.
  //   2. Collect each `response.output_item.done` item (deduplicated by
  //      `output_index`, latest write wins). These are the FINAL forms
  //      of the output items — they include the full `content` array
  //      for messages and the complete `arguments` string for tool
  //      calls.
  //   3. Use `response.completed` only as the "stream finished" signal
  //      and to extract the response id and usage stats.
  //   4. Surface `response.failed` / `error` events as exceptions.
  const events = parseSSE(text);
  const itemByIndex = new Map<string | number, Record<string, unknown>>();
  let completedResponse: Record<string, unknown> | null = null;
  let failureMessage: string | null = null;

  for (const evt of events) {
    const type = stringValue(evt.type);
    if (type === "response.output_item.done") {
      const item = asOptionalRecord(evt.item);
      if (item) {
        const key = outputKey(evt.output_index) ?? (stringValue(item.id) || itemByIndex.size);
        itemByIndex.set(key, item);
      }
    } else if (type === "response.completed") {
      completedResponse = asOptionalRecord(evt.response) ?? {};
    } else if (type === "response.incomplete") {
      completedResponse = asOptionalRecord(evt.response) ?? {};
    } else if (type === "response.failed") {
      failureMessage = getNestedString(evt.response, ["error", "message"]) ?? "ChatGPT OAuth response failed";
    } else if (type === "error" && typeof evt.message === "string") {
      failureMessage = evt.message;
    }
  }

  if (failureMessage) throw new ChatGPTOAuthError(failureMessage);

  if (completedResponse || itemByIndex.size > 0) {
    // Synthesize a Responses-API-shaped object from the streamed pieces.
    const synthesized: Record<string, unknown> = {
      ...(completedResponse ?? {}),
      output: Array.from(itemByIndex.values()),
    };
    return synthesized;
  }

  throw new ChatGPTOAuthError(
    "ChatGPT OAuth stream ended without a completed response.",
  );
}

function parseSSE(text: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  // SSE events are separated by blank lines. Each event has `data:` lines
  // (potentially multi-line JSON) and optional `event:` / `id:` lines we
  // can ignore — the JSON payload always carries `type`.
  const blocks = text.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const lines = block.split(/\r?\n/);
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
      }
    }
    if (dataLines.length === 0) continue;
    const payload = dataLines.join("\n");
    if (payload === "[DONE]") continue;
    try {
      const event: unknown = JSON.parse(payload);
      if (isRecord(event)) events.push(event);
    } catch {
      // ignore malformed event
    }
  }
  return events;
}

// ─── Input building ─────────────────────────────────────────────────────────

/**
 * Convert the agent loop's full message history into Responses-API input
 * items. The Codex backend rejects `previous_response_id` (because we must
 * send `store:false`), so every request carries the entire conversation.
 *
 * Encoding rules:
 *   - string content        → { type:"message", role, content }
 *   - text/image blocks     → { type:"message", role, content:[...] }
 *   - tool_use block        → { type:"function_call", call_id, name, arguments }
 *   - tool_result block     → { type:"function_call_output", call_id, output }
 *
 * The system prompt is sent separately via the `instructions` field, so we
 * never include it here.
 */
function buildFullHistoryInput(
  messages: UnifiedMessage[],
): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = [];

  for (const msg of messages) {
    const role = msg.role === "assistant" ? "assistant" : "user";

    if (typeof msg.content === "string") {
      items.push({ type: "message", role, content: msg.content });
      continue;
    }

    const content: Array<Record<string, unknown>> = [];
    const flushContent = () => {
      if (content.length === 0) return;
      items.push({ type: "message", role, content: content.splice(0) });
    };

    for (const block of msg.content) {
      if (block.type === "text" && block.text) {
        content.push({ type: "input_text", text: block.text });
      } else if (block.type === "image" && block.image) {
        content.push({
          type: "input_image",
          image_url: `data:${block.image.mediaType};base64,${block.image.data}`,
          detail: "auto",
        });
      } else if (block.type === "tool_use" && block.name && block.id) {
        flushContent();
        items.push({
          type: "function_call",
          call_id: block.id,
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        });
      } else if (block.type === "tool_result" && block.tool_use_id) {
        flushContent();
        items.push({
          type: "function_call_output",
          call_id: block.tool_use_id,
          output: block.content ?? "",
        });
      }
    }
    flushContent();
  }

  return items;
}

// ─── Response parsing (mirrors openai.ts) ───────────────────────────────────

function fromResponsesOutput(data: Record<string, unknown>): UnifiedResponse {
  const output = Array.isArray(data.output) ? data.output.filter(isRecord) : [];
  const content: ContentBlock[] = [];
  let hasToolCalls = false;

  for (const item of output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content.filter(isRecord)) {
        if (part.type === "output_text" && typeof part.text === "string") {
          content.push({ type: "text", text: part.text });
        }
      }
    } else if (item.type === "function_call") {
      hasToolCalls = true;
      let input: Record<string, unknown> = {};
      try {
        const parsed: unknown = JSON.parse(typeof item.arguments === "string" ? item.arguments : "{}");
        input = isRecord(parsed) ? parsed : { _raw: parsed };
      } catch {
        input = { _raw: item.arguments };
      }
      content.push({
        type: "tool_use",
        id: stringValue(item.call_id) || stringValue(item.id),
        name: stringValue(item.name),
        input,
      });
    }
  }

  const stopReason = hasToolCalls ? "tool_use" : "end_turn";
  const usage = isRecord(data.usage) ? data.usage : undefined;

  return {
    content,
    stopReason,
    usage: usage
      ? { inputTokens: numberValue(usage.input_tokens), outputTokens: numberValue(usage.output_tokens) }
      : undefined,
  };
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function outputKey(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function getNestedString(value: unknown, path: string[]): string | undefined {
  let current: unknown = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === "string" ? current : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function asOptionalRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
