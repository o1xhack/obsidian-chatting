import { supportsReasoning, catalogIdentity } from "./model-catalog";
import { requestUrl } from "obsidian";
import { serializeRequest } from "./request-budget";
import { ProviderError, retryAfterMs } from "./errors";
import type {
  ChatSettings,
  UnifiedMessage,
  UnifiedToolDef,
  UnifiedResponse,
  ProviderReplay,
} from "../types";

import { withoutOldToolImages } from "../agent/history";
import { buildResponsesInput, fromResponsesOutput } from "./responses-format";
import { activeServers, openaiMcpTools, mcpServerIdentities } from "./mcp";

const DEFAULT_OPENAI_URL = "https://api.openai.com";

interface ConversationState {
  responseId: string;
  model: string;
  apiKey: string;
  messages: UnifiedMessage[];
  replay: ProviderReplay | undefined;
  mcpConfig: string;
}

// Connection tests and other conversations must never replace this chat's cursor.
let conversations = new WeakMap<UnifiedMessage[], ConversationState>();

export function clearOpenAIState(): void {
  conversations = new WeakMap();
}

/**
 * Sends a message to OpenAI via the Responses API (/v1/responses).
 * Uses the `previous_response_id` field for multi-turn, which lets
 * OpenAI manage conversation state server-side and avoids us having to
 * reconstruct function_call items.
 */
export async function sendOpenAIMessage(
  settings: ChatSettings,
  messages: UnifiedMessage[],
  tools: UnifiedToolDef[],
  systemPrompt: string
): Promise<UnifiedResponse> {
  const baseUrl = DEFAULT_OPENAI_URL;
  const model = settings.model;

  const identity = await catalogIdentity("openai", settings.apiKey);
  // Snapshot before awaiting transport: UI edits must not change the cursor's
  // configuration. This stays in memory only, including authorization tokens.
  const servers = activeServers(settings).map(server => ({ ...server }));
  const mcpConfig = JSON.stringify(servers);
  const previous = conversations.get(messages);
  const prepared = withoutOldToolImages(messages);
  // Omitted images also have to leave the server-side context. A response
  // cursor still retains them, so replay whenever the full history is pruned.
  const imagesPruned = prepared.some((message, index) => message !== messages[index]);
  const canChain = !imagesPruned && previous?.model === model && previous.apiKey === settings.apiKey && previous.mcpConfig === mcpConfig &&
    previous.messages.length < messages.length &&
    previous.messages.every((message, index) => message === messages[index]) &&
    messages[previous.messages.length]?.role === "assistant" &&
    messages[previous.messages.length]?.replay === previous.replay;
  // Rebuilt/restored histories include native response items and tool pairs.
  const input = buildResponsesInput(canChain ? messages.slice(previous.messages.length + 1) : prepared, "openai", model, identity, servers);

  const body: Record<string, unknown> = {
    model,
    input,
  };

  // Chain to previous response for multi-turn context
  if (canChain) {
    body.previous_response_id = previous.responseId;
  }

  // Reasoning for reasoning-capable models
  if (supportsReasoning(model)) {
    body.reasoning = { effort: "medium" };
    body.include = ["reasoning.encrypted_content"];
  }

  // Tools
  const apiTools: Record<string, unknown>[] = tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
    strict: false,
  }));

  if (settings.enableWebSearch) {
    apiTools.push({ type: "web_search" });
  }
  // Remote MCP servers, connected by OpenAI (`api/mcp.ts`).
  apiTools.push(...openaiMcpTools(servers));

  if (apiTools.length > 0) {
    body.tools = apiTools;
  }

  // Always send instructions (system prompt) since previous_response_id
  // doesn't carry forward the system prompt
  body.instructions = systemPrompt;

  const requestBody = serializeRequest(body);
  let response;
  try {
    response = await requestUrl({
      url: `${baseUrl}/v1/responses`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: requestBody,
      throw: false,
    });
  } catch (e: unknown) {
    const err = asRecord(e);
    const status = typeof err.status === "number" || typeof err.status === "string" ? String(err.status) : "";
    const message = typeof err.message === "string" ? err.message : String(e);
    const apiMsg = getNestedString(err, ["json", "error", "message"]);
    if (apiMsg) {
      throw new Error(`OpenAI API error (${status || "unknown"}): ${apiMsg}`);
    }
    throw new Error(`OpenAI request failed (${status}): ${message}`);
  }

  if (response.status !== 200) {
    const json = response.json as unknown;
    const errorBody = getNestedString(json, ["error", "message"]) ?? `HTTP ${response.status}`;
    throw new ProviderError(`OpenAI API error (${response.status}): ${errorBody}`, response.status,
      getNestedString(json, ["error", "code"]) ?? getNestedString(json, ["error", "type"]), retryAfterMs(response.headers));
  }

  const data = asRecord(response.json as unknown);

  const result = fromResponsesOutput(data, "openai", model, identity);
  if (result.replay) result.replay.mcpServers = mcpServerIdentities(servers);
  if (typeof data.id === "string") {
    conversations.set(messages, { responseId: data.id, model, apiKey: settings.apiKey, messages: [...messages], replay: result.replay, mcpConfig });
  } else {
    conversations.delete(messages);
  }
  return result;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
