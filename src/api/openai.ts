import { supportsReasoning, cachedCatalog, catalogIdentity } from "./model-catalog";
import { compactThreshold } from "../agent/compaction";
import { ProviderError } from "./errors";
import { getNestedString } from "../json";
import type {
  ChatSettings,
  UnifiedMessage,
  UnifiedToolDef,
  UnifiedResponse,
  ProviderReplay,
  StreamOptions,
} from "../types";

import { buildResponsesInput, compactionParameter, fromResponsesOutput, sendResponsesRequest } from "./responses-format";
import { activeServers, openaiMcpTools } from "./mcp";

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
 * reconstruct function_call items. The answer is streamed (`api/stream.ts`).
 */
export async function sendOpenAIMessage(
  settings: ChatSettings,
  messages: UnifiedMessage[],
  tools: UnifiedToolDef[],
  systemPrompt: string,
  stream: StreamOptions = {},
): Promise<UnifiedResponse> {
  const baseUrl = DEFAULT_OPENAI_URL;
  const model = settings.model;

  const identity = await catalogIdentity("openai", settings.apiKey);
  const previous = conversations.get(messages);
  const canChain = previous?.model === model && previous.apiKey === settings.apiKey &&
    previous.messages.length < messages.length &&
    previous.messages.every((message, index) => message === messages[index]) &&
    messages[previous.messages.length]?.role === "assistant" &&
    messages[previous.messages.length]?.replay === previous.replay;
  // Rebuilt/restored histories include native response items and tool pairs.
  const input = buildResponsesInput(canChain ? messages.slice(previous.messages.length + 1) : messages, "openai", model, identity, activeServers(settings));

  // Server-side compaction at the model's compaction point; its window comes
  // from the model's documentation page (`loadModelDetails`).
  const option = settings.modelCatalog
    ? cachedCatalog(settings.modelCatalog, "openai", identity)?.models.find((item) => item.value === model)
    : undefined;
  const body: Record<string, unknown> = {
    model,
    input,
    stream: true,
    ...compactionParameter(compactThreshold("openai", option, settings)),
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
  apiTools.push(...openaiMcpTools(activeServers(settings)));

  if (apiTools.length > 0) {
    body.tools = apiTools;
  }

  // Always send instructions (system prompt) since previous_response_id
  // doesn't carry forward the system prompt
  body.instructions = systemPrompt;

  const data = await sendResponsesRequest(`${baseUrl}/v1/responses`, {
    Authorization: `Bearer ${settings.apiKey}`,
    "Content-Type": "application/json",
    Accept: "text/event-stream",
  }, body, stream, "OpenAI", {
    http: (response) => new ProviderError(
      `OpenAI API error (${response.status}): ${getNestedString(response.json, ["error", "message"]) ?? `HTTP ${response.status}`}`,
      response.status, getNestedString(response.json, ["error", "code"]) ?? getNestedString(response.json, ["error", "type"]),
      response.retryAfterMs),
    // Status 0: the error came inside a response that had started; its code decides on a retry.
    stream: ({ message, code }) => new ProviderError(message, 0, code),
  });

  const result = fromResponsesOutput(data, "openai", model, identity);
  if (typeof data.id === "string") {
    conversations.set(messages, { responseId: data.id, model, apiKey: settings.apiKey, messages: [...messages], replay: result.replay });
  } else {
    conversations.delete(messages);
  }
  return result;
}
