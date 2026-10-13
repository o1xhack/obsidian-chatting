import { type ModelOption, cachedCatalog, catalogIdentity, catalogModel, resolveThinkingLevel } from "./model-catalog";
import { serializeRequest } from "./request-budget";
import { ProviderError, StreamCutError } from "./errors";
import { StreamDropped, streamSSE } from "./stream";
import { asRecord, getNestedString, isRecord } from "../json";
import { withoutOldToolImages } from "../agent/history";
import { afterCompaction, compactThreshold } from "../agent/compaction";
import { ANTHROPIC_MCP_BETA, activeServers, anthropicMcp, anthropicServerCalls, withServerCalls, withoutGoneServerCalls } from "./mcp";
import type {
  ChatSettings,
  McpServer,
  UnifiedMessage,
  UnifiedToolDef,
  UnifiedResponse,
  ContentBlock,
  ImageAttachment,
  FileAttachment,
  StreamOptions,
  TokenUsage,
} from "../types";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

/** The beta header of threshold compaction. */
export const ANTHROPIC_COMPACTION_BETA = "compact-2026-01-12";

/**
 * Thinking mode by model name, for models without catalog data (a custom ID,
 * or a list saved before the catalog's capabilities were read).
 * Opus 4.7+ rejects manual thinking. Keep older models on their budget mode.
 */
function thinkingTypeByName(model: string): ModelOption["thinkingType"] {
  const generation = model.match(/^claude-(?:sonnet|opus)-(\d+)[-.](\d{1,2})(?:-|$)/);
  const supportsAdaptive = !!generation && (Number(generation[1]) > 4 ||
    (Number(generation[1]) === 4 && Number(generation[2]) >= 6));
  const supportsThinking = model.includes("claude-sonnet-4") || model.includes("claude-opus") || model.includes("claude-sonnet-3-7");
  return supportsAdaptive ? "adaptive" : supportsThinking ? "enabled" : undefined;
}

/**
 * Sends a message to the Anthropic Messages API. The answer is streamed
 * (`api/stream.ts`) and rebuilt into the same message the non-streamed API
 * returns.
 *
 * Anthropic format:
 * - System prompt is a top-level field, not a message
 * - Tools use `input_schema` (not `parameters`)
 * - Tool results are sent as user messages with type "tool_result"
 */
export async function sendAnthropicMessage(
  settings: ChatSettings,
  messages: UnifiedMessage[],
  tools: UnifiedToolDef[],
  systemPrompt: string,
  stream: StreamOptions = {},
): Promise<UnifiedResponse> {
  const model = settings.model;
  const identity = await catalogIdentity("anthropic", settings.apiKey);
  if (settings.modelCatalog) {
    cachedCatalog(settings.modelCatalog, "anthropic", identity);
  }
  const body: Record<string, unknown> = {
    model,
    max_tokens: 16384,
    stream: true,
    // System prompt as a content block with cache_control breakpoint.
    // Anthropic caches everything up to the breakpoint across requests.
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    // After a compaction, from its message on: the API ignores what came before.
    messages: withoutOldToolImages(afterCompaction(messages, (message) => canReplay(message, model, identity)))
      .map(msg => toAnthropicMessage(msg, model, identity, activeServers(settings))),
  };

  // The thinking mode the model catalog reports (`/v1/models` capabilities);
  // models it has no data for keep the rule by model name.
  const option = catalogModel("anthropic", model);

  // Threshold compaction where the model list says the model has it.
  const betas: string[] = [];
  const trigger = option?.compaction ? compactThreshold("anthropic", option) : undefined;
  if (trigger) {
    body.context_management = { edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: trigger } }] };
    betas.push(ANTHROPIC_COMPACTION_BETA);
  }
  const thinkingType = option?.thinkingType ?? thinkingTypeByName(model);

  if (thinkingType === "adaptive") {
    // Adaptive: Claude decides when/how much to think per request
    body.thinking = { type: "adaptive" };
  } else if (thinkingType === "enabled") {
    // Manual: fixed budget for older models
    body.thinking = { type: "enabled", budget_tokens: 8192 };
  }
  // The thinking level picked in settings, if the catalog lists it for the model.
  const effort = resolveThinkingLevel(option, settings.thinkingLevel);
  if (effort) body.output_config = { effort };

  if (tools.length > 0 || settings.enableWebSearch) {
    const apiTools: Record<string, unknown>[] = tools.map((t, i, arr) => {
      const tool: Record<string, unknown> = {
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      };
      // Place cache_control breakpoint on the last function tool
      // so the entire tools array prefix is cached
      if (i === arr.length - 1 && !settings.enableWebSearch) {
        tool.cache_control = { type: "ephemeral" };
      }
      return tool;
    });

    // Anthropic web search is a server-managed tool
    if (settings.enableWebSearch) {
      apiTools.push({
        type: "web_search_20250305",
        name: "web_search",
        max_uses: 3,
        cache_control: { type: "ephemeral" },
      });
    }

    body.tools = apiTools;
  }

  // Remote MCP servers, connected by Anthropic (`api/mcp.ts`).
  const servers = activeServers(settings);
  if (servers.length) {
    betas.push(ANTHROPIC_MCP_BETA);
    const mcp = anthropicMcp(servers);
    body.mcp_servers = mcp.mcp_servers;
    body.tools = [...Array.isArray(body.tools) ? body.tools as Record<string, unknown>[] : [], ...mcp.toolsets];
  }

  const requestBody = serializeRequest(body);
  const collected = collectAnthropicStream(stream.onTextDelta, stream.onServerTool);
  const response = await streamSSE(ANTHROPIC_API_URL, {
    headers: {
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
      accept: "text/event-stream",
      // Required for the CORS answer to `fetch` from Obsidian's origins (mobile).
      "anthropic-dangerous-direct-browser-access": "true",
      ...(betas.length ? { "anthropic-beta": betas.join(",") } : {}),
    },
    body: requestBody,
  }, collected.onEvent, stream.signal).catch((error: unknown) => {
    // The connection was lost after the answer began: a cut stream.
    throw error instanceof StreamDropped ? new StreamCutError("Anthropic", collected.serverTool()) : error;
  });

  if (response.status !== 200) {
    const errorText = getNestedString(response.json, ["error", "message"]) ?? `HTTP ${response.status}`;
    throw new ProviderError(`Anthropic API error (${response.status}): ${errorText}`, response.status,
      getNestedString(response.json, ["error", "type"]), response.retryAfterMs);
  }

  const data = parseAnthropicResponse(collected.finish());
  const content = data.content.map(fromAnthropicBlock).filter((b): b is ContentBlock => b !== null);
  const sources = citedSources(data.content);
  if (sources) {
    // Right after the answer's text, before any tool call: in the history
    // another provider gets, text after a call would split it from its result.
    const firstCall = content.findIndex((b) => b.type === "tool_use");
    content.splice(firstCall === -1 ? content.length : firstCall, 0, sources);
  }

  return {
    content,
    // Thinking signatures, redacted thinking, citations and server tool results
    // must be returned unchanged. UI content is deliberately separate.
    replay: { provider: "anthropic", model, identity, items: data.content },
    stopReason: normalizeStopReason(data.stop_reason),
    usage: data.usage,
    ...withServerCalls(anthropicServerCalls(data.content)),
    ...compactionOf(data.content),
  };
}

/** A `compaction` block in the answer: the context was summarized, readably. */
function compactionOf(blocks: AnthropicContentBlock[]): Pick<UnifiedResponse, "compaction"> {
  const block = [...blocks].reverse().find((item) => item.type === "compaction");
  if (!block) return {};
  return { compaction: typeof block.content === "string" && block.content ? { summary: block.content } : {} };
}

/**
 * Anthropic usage: `input_tokens` counts only the uncached input, so the
 * context is it plus `cache_read_input_tokens` and
 * `cache_creation_input_tokens`. A compaction pass (`iterations` of type
 * `compaction`) isn't in the top-level counts.
 */
function anthropicUsage(usage: Record<string, unknown>): TokenUsage {
  const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const cached = number(usage.cache_read_input_tokens);
  const written = number(usage.cache_creation_input_tokens);
  const compaction = Array.isArray(usage.iterations)
    ? usage.iterations.filter(isRecord).filter((item) => item.type === "compaction")
    : [];
  const compactionInput = compaction.reduce((sum, item) => sum + number(item.input_tokens), 0);
  const compactionOutput = compaction.reduce((sum, item) => sum + number(item.output_tokens), 0);
  return {
    inputTokens: number(usage.input_tokens) + cached + written,
    outputTokens: number(usage.output_tokens),
    ...(cached ? { cachedInputTokens: cached } : {}),
    ...(written ? { cacheWriteTokens: written } : {}),
    ...(compactionInput || compactionOutput ? { compactionInputTokens: compactionInput, compactionOutputTokens: compactionOutput } : {}),
  };
}

// ─── Streaming ──────────────────────────────────────────────────────────────

/**
 * Rebuilds the message from Messages API stream events, block by block:
 * text, thinking and signatures are concatenated from their deltas, tool
 * inputs (also of MCP calls) parsed from their JSON deltas, citations
 * collected; other blocks (redacted thinking, web search and MCP tool
 * results) arrive whole in `content_block_start`. Text deltas also go to
 * `onTextDelta`.
 */
function collectAnthropicStream(onTextDelta?: (text: string) => void, onServerTool?: () => void): {
  onEvent: (event: Record<string, unknown>) => void;
  finish: () => Record<string, unknown>;
  /** An MCP call started in this answer. */
  serverTool: () => boolean;
} {
  let serverTool = false;
  let message: Record<string, unknown> | undefined;
  const blocks: Record<string, unknown>[] = [];
  const inputJson = new Map<number, string>();
  let stopped = false;
  let failure: ProviderError | undefined;
  return {
    onEvent: (event) => {
      const index = typeof event.index === "number" ? event.index : -1;
      const delta = asRecord(event.delta);
      switch (event.type) {
        case "message_start":
          message = { ...asRecord(event.message) };
          break;
        case "content_block_start":
          if (index >= 0 && isRecord(event.content_block)) {
            blocks[index] = { ...event.content_block };
            if (event.content_block.type === "mcp_tool_use" && !serverTool) {
              serverTool = true;
              onServerTool?.();
            }
          }
          break;
        case "content_block_delta": {
          const block = blocks[index];
          if (!block) break;
          if (delta.type === "text_delta" && typeof delta.text === "string") {
            block.text = (typeof block.text === "string" ? block.text : "") + delta.text;
            if (delta.text) onTextDelta?.(delta.text);
          } else if (delta.type === "thinking_delta" && typeof delta.thinking === "string") {
            block.thinking = (typeof block.thinking === "string" ? block.thinking : "") + delta.thinking;
          } else if (delta.type === "signature_delta" && typeof delta.signature === "string") {
            block.signature = (typeof block.signature === "string" ? block.signature : "") + delta.signature;
          } else if (delta.type === "input_json_delta" && typeof delta.partial_json === "string") {
            inputJson.set(index, (inputJson.get(index) ?? "") + delta.partial_json);
          } else if (delta.type === "compaction_delta" && typeof delta.content === "string") {
            // The whole summary of a compaction, in one delta.
            block.content = (typeof block.content === "string" ? block.content : "") + delta.content;
          } else if (delta.type === "citations_delta" && delta.citation !== undefined) {
            block.citations = [...(Array.isArray(block.citations) ? block.citations as unknown[] : []), delta.citation];
          }
          break;
        }
        case "content_block_stop": {
          const json = inputJson.get(index);
          const block = blocks[index];
          if (block && json) {
            try {
              const input: unknown = JSON.parse(json);
              if (isRecord(input)) block.input = input;
            } catch {
              // Truncated input (max_tokens): the loop won't run this call.
            }
          }
          // A server_tool_use may start without `input`; replay needs one.
          if (block && (block.type === "tool_use" || block.type === "server_tool_use" || block.type === "mcp_tool_use") && !isRecord(block.input)) block.input = {};
          break;
        }
        case "message_delta":
          if (message) {
            Object.assign(message, delta);
            if (isRecord(event.usage)) message.usage = { ...asRecord(message.usage), ...event.usage };
          }
          break;
        case "message_stop":
          stopped = true;
          break;
        case "error": {
          // Status 0: the error came inside the stream; its type decides on a retry.
          const error = asRecord(event.error);
          const type = typeof error.type === "string" ? error.type : "error";
          failure = new ProviderError(`Anthropic API error (${type}): ${typeof error.message === "string" ? error.message : "stream failed"}`, 0, type);
          break;
        }
      }
    },
    finish: () => {
      if (failure) throw failure;
      if (!message || !stopped) throw new StreamCutError("Anthropic", serverTool);
      return { ...message, content: blocks.filter(Boolean) };
    },
    serverTool: () => serverTool,
  };
}

// ─── Format Conversions ─────────────────────────────────────────────────────

interface AnthropicContentBlock extends Record<string, unknown> {
  type: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  citations?: unknown;
}

interface AnthropicResponse {
  content: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: TokenUsage;
}

function parseAnthropicResponse(value: unknown): AnthropicResponse {
  if (!isRecord(value)) return { content: [] };
  const content = Array.isArray(value.content)
    ? value.content.filter(isAnthropicContentBlock)
    : [];
  const usage = isRecord(value.usage) ? anthropicUsage(value.usage) : undefined;
  return {
    content,
    stop_reason: typeof value.stop_reason === "string" ? value.stop_reason : undefined,
    usage,
  };
}

function isAnthropicContentBlock(value: unknown): value is AnthropicContentBlock {
  return isRecord(value) && typeof value.type === "string";
}

function normalizeStopReason(value: string | undefined): UnifiedResponse["stopReason"] {
  if (value === "tool_use" || value === "max_tokens" || value === "stop" || value === "pause_turn") return value;
  return "end_turn";
}

/** An Anthropic answer of this model and account: its native blocks go back unchanged. */
function canReplay(msg: UnifiedMessage, model: string, identity: string): boolean {
  return msg.role === "assistant" && msg.replay?.provider === "anthropic" && (!msg.replay.model || msg.replay.model === model) && (!msg.replay.identity || msg.replay.identity === identity);
}

function toAnthropicMessage(msg: UnifiedMessage, model: string, identity: string, servers: McpServer[]): Record<string, unknown> {
  if (canReplay(msg, model, identity) && msg.replay) {
    const content = withoutGoneServerCalls(msg.replay.items, servers);
    // Nothing but calls of servers that are gone: sent as text below.
    if (content.length) return { role: msg.role, content };
  }
  if (typeof msg.content === "string") {
    return { role: msg.role, content: msg.content };
  }

  // Content blocks (tool_use responses from assistant, tool_result from user)
  const blocks = msg.content.map((block) => {
    if (block.type === "tool_result") {
      // Images from view_image/view_canvas and files from read_file go inside the tool_result.
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.images?.length || block.files?.length
          ? [
              { type: "text", text: block.content || "(attached)" },
              ...(block.images ?? []).map(anthropicImage),
              ...(block.files ?? []).map(anthropicFile),
            ]
          : block.content,
        is_error: block.is_error || false,
      };
    }
    if (block.type === "tool_use") {
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      };
    }
    if (block.type === "image" && block.image) {
      return anthropicImage(block.image);
    }
    if (block.type === "file" && block.file) {
      return anthropicFile(block.file);
    }
    return { type: "text", text: block.text };
  }).filter((b) => !(b.type === "text" && !b.text));

  return { role: msg.role, content: blocks };
}

/**
 * A file: a PDF as a document Claude reads with its page images; Office and
 * text files as a text document (Claude doesn't read Office files, so their
 * text was read when attached); others named only.
 */
function anthropicFile(file: FileAttachment): Record<string, unknown> {
  if (file.mediaType === "application/pdf" && file.data) {
    return { type: "document", source: { type: "base64", media_type: "application/pdf", data: file.data }, title: file.fileName };
  }
  if (file.text?.trim()) {
    return { type: "document", source: { type: "text", media_type: "text/plain", data: file.text }, title: file.fileName };
  }
  return { type: "text", text: `[${file.fileName}: Claude can't read this file type, or it has no text. Ask the user for it as a PDF, or as a .docx, .xlsx or .pptx file.]` };
}

function anthropicImage(image: ImageAttachment): Record<string, unknown> {
  return {
    type: "image",
    source: { type: "base64", media_type: image.mediaType, data: image.data },
  };
}

/**
 * The web pages a web search answer cites (`web_search_result_location`
 * citations on its text blocks), each once, as a list after the answer:
 * Anthropic asks apps to show the sources with the answer.
 */
function citedSources(blocks: AnthropicContentBlock[]): ContentBlock | null {
  const sources = new Map<string, string>();
  for (const block of blocks) {
    if (block.type !== "text" || !Array.isArray(block.citations)) continue;
    for (const citation of block.citations as unknown[]) {
      if (!isRecord(citation) || citation.type !== "web_search_result_location" || typeof citation.url !== "string") continue;
      if (!sources.has(citation.url)) sources.set(citation.url, typeof citation.title === "string" && citation.title ? citation.title : citation.url);
    }
  }
  if (sources.size === 0) return null;
  const links = [...sources].map(([url, title]) =>
    `- [${title.replace(/[\\[\]]/g, "\\$&")}](${url.replace(/[ ()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)})`);
  return { type: "text", text: `\n\nSources:\n${links.join("\n")}` };
}

function fromAnthropicBlock(block: AnthropicContentBlock): ContentBlock | null {
  if (block.type === "tool_use") {
    return {
      type: "tool_use",
      id: block.id,
      name: block.name,
      input: block.input,
    };
  }
  // Thinking and web search (`server_tool_use`, `web_search_tool_result`,
  // whose `content` holds encrypted results) are internal: they go back
  // unchanged in the replay; the pages cited show as sources. MCP calls
  // likewise; they show as tool steps (`serverCalls`).
  if (block.type === "thinking" || block.type === "server_tool_use" || block.type === "web_search_tool_result" ||
    block.type === "mcp_tool_use" || block.type === "mcp_tool_result") {
    return null;
  }
  // Skip blocks with no text content (safety net)
  if (!block.text) {
    return null;
  }
  return { type: "text", text: block.text };
}
