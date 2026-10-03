import { supportsReasoning, catalogIdentity } from "./model-catalog";
import { requestUrl } from "obsidian";
import type {
  ChatSettings,
  UnifiedMessage,
  UnifiedToolDef,
  UnifiedResponse,
  ProviderReplay,
} from "../types";

import { buildResponsesInput, fromResponsesOutput } from "./responses-format";

const DEFAULT_OPENAI_URL = "https://api.openai.com";

interface ConversationState {
  responseId: string;
  model: string;
  apiKey: string;
  messages: UnifiedMessage[];
  replay: ProviderReplay | undefined;
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
  const model = settings.model || "gpt-6.1-sol";

  const identity = await catalogIdentity("openai", settings.apiKey);
  const previous = conversations.get(messages);
  const canChain = previous?.model === model && previous.apiKey === settings.apiKey &&
    previous.messages.length < messages.length &&
    previous.messages.every((message, index) => message === messages[index]) &&
    messages[previous.messages.length]?.role === "assistant" &&
    messages[previous.messages.length]?.replay === previous.replay;
  // Rebuilt/restored histories include native response items and tool pairs.
  const input = buildResponsesInput(canChain ? messages.slice(previous.messages.length + 1) : messages, "openai", model, identity);

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

  if (apiTools.length > 0) {
    body.tools = apiTools;
  }

  // Always send instructions (system prompt) since previous_response_id
  // doesn't carry forward the system prompt
  body.instructions = systemPrompt;

  let response;
  try {
    response = await requestUrl({
      url: `${baseUrl}/v1/responses`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${settings.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
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
    const errorBody = getNestedString(response.json as unknown, ["error", "message"]) ?? `HTTP ${response.status}`;
    throw new Error(`OpenAI API error (${response.status}): ${errorBody}`);
  }

  const data = asRecord(response.json as unknown);

  const result = fromResponsesOutput(data, "openai", model, identity);
  if (typeof data.id === "string") {
    conversations.set(messages, { responseId: data.id, model, apiKey: settings.apiKey, messages: [...messages], replay: result.replay });
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
