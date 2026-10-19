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

import { withoutOldToolImages } from "../agent/history";
import { buildResponsesInput, compactionParameter, fromResponsesOutput, sendResponsesRequest } from "./responses-format";
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

  // Server-side compaction at the model's compaction point; its window comes
  // from the model's documentation page (`loadModelDetails`).
  const option = settings.modelCatalog
    ? cachedCatalog(settings.modelCatalog, "openai", identity)?.models.find((item) => item.value === model)
    : undefined;
  const body: Record<string, unknown> = {
    model,
    input,
    stream: true,
    ...compactionParameter(compactThreshold("openai", option)),
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

  let result: UnifiedResponse;
  try {
    result = fromResponsesOutput(data, "openai", model, identity);
  } catch (error) {
    conversations.delete(messages);
    if (error instanceof ProviderError && error.partialResponse?.replay) {
      error.partialResponse.replay.mcpServers = mcpServerIdentities(servers);
    }
    throw error;
  }
  if (result.replay) result.replay.mcpServers = mcpServerIdentities(servers);
  if (typeof data.id === "string") {
    conversations.set(messages, { responseId: data.id, model, apiKey: settings.apiKey, messages: [...messages], replay: result.replay, mcpConfig });
  } else {
    conversations.delete(messages);
  }
  return result;
}
