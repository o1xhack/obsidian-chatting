import { type ModelOption, cachedCatalog, catalogIdentity, catalogModel, resolveThinkingLevel } from "./model-catalog";
import { serializeRequest } from "./request-budget";
import { ProviderError, StreamCutError } from "./errors";
import { StreamDropped, streamSSE } from "./stream";
import { asRecord, getNestedString, isRecord } from "../json";
import { withoutOldToolImages } from "../agent/history";
import { ANTHROPIC_MCP_BETA, activeServers, anthropicMcp, anthropicServerCalls, withServerCalls, withoutGoneServerCalls, mcpServerIdentities } from "./mcp";
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
} from "../types";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

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
  const servers = activeServers(settings).map(server => ({ ...server }));
  const priorReplays = messages.filter(message => message.role === "assistant" && message.replay?.provider === "anthropic" &&
    (!message.replay.model || message.replay.model === model) && (!message.replay.identity || message.replay.identity === identity))
    .map(message => message.replay!);
  // A paused server call and its eventual result can live in different
  // assistant messages. Filter results against all retained calls, not one row.
  const retainedCallIds = new Set(priorReplays.flatMap(replay => withoutGoneServerCalls(replay.items, servers, replay.mcpServers))
    .filter(item => item.type === "mcp_tool_use").map(item => item.id));
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
    messages: withoutOldToolImages(messages).map(msg => toAnthropicMessage(msg, model, identity, servers, retainedCallIds)),
  };

  // The thinking mode the model catalog reports (`/v1/models` capabilities);
  // models it has no data for keep the rule by model name.
  const option = catalogModel("anthropic", model);
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
  if (servers.length) {
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
      ...(servers.length ? { "anthropic-beta": ANTHROPIC_MCP_BETA } : {}),
    },
    body: requestBody,
    noFallback: servers.length > 0,
  }, collected.onEvent, stream.signal).catch((error: unknown) => {
    throw withReceipts(error instanceof StreamDropped ? new StreamCutError("Anthropic", collected.serverTool()) : error);
  });

  if (response.status !== 200) {
    const errorText = getNestedString(response.json, ["error", "message"]) ?? `HTTP ${response.status}`;
    throw new ProviderError(`Anthropic API error (${response.status}): ${errorText}`, response.status,
      getNestedString(response.json, ["error", "type"]), response.retryAfterMs);
  }

  let complete: Record<string, unknown>;
  try { complete = collected.finish(); }
  catch (error) { throw withReceipts(error); }
  return toResponse(complete);

  function withReceipts(error: unknown): unknown {
    if (!collected.serverTool() && !servers.length) return error;
    const source = error instanceof Error ? error.message : String(error);
    const partial = toResponse(collected.snapshot());
    if (!partial.serverCalls?.length) partial.content.push({ type: "text", text: "Remote MCP request outcome unknown. Check the external service before repeating this request." });
    return new ProviderError(source + " Remote MCP tools may already have run; check their results before retrying.", 0,
      error instanceof ProviderError ? error.code : undefined, undefined, true, partial);
  }

  function toResponse(packet: Record<string, unknown>): UnifiedResponse {
  const data = parseAnthropicResponse(packet);
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
    replay: { provider: "anthropic", model, identity, items: data.content, mcpServers: mcpServerIdentities(servers) },
    stopReason: normalizeStopReason(data.stop_reason),
    usage: data.usage
      ? { inputTokens: data.usage.input_tokens ?? 0, outputTokens: data.usage.output_tokens ?? 0 }
      : undefined,
    ...withServerCalls(anthropicServerCalls(data.content, messages.flatMap(message => message.replay?.provider === "anthropic" ? message.replay.items : []))),
  };
  }
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
  snapshot: () => Record<string, unknown>;
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
    snapshot: () => ({ ...message, content: blocks.filter(Boolean) }),
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
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

function parseAnthropicResponse(value: unknown): AnthropicResponse {
  if (!isRecord(value)) return { content: [] };
  const content = Array.isArray(value.content)
    ? value.content.filter(isAnthropicContentBlock)
    : [];
  const usage = isRecord(value.usage)
    ? {
        input_tokens: typeof value.usage.input_tokens === "number" ? value.usage.input_tokens : 0,
        output_tokens: typeof value.usage.output_tokens === "number" ? value.usage.output_tokens : 0,
      }
    : undefined;
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

function toAnthropicMessage(msg: UnifiedMessage, model: string, identity: string, servers: McpServer[], retainedCallIds: ReadonlySet<unknown>): Record<string, unknown> {
  if (msg.role === "assistant" && msg.replay?.provider === "anthropic" && (!msg.replay.model || msg.replay.model === model) && (!msg.replay.identity || msg.replay.identity === identity)) {
    const content = withoutGoneServerCalls(msg.replay.items, servers, msg.replay.mcpServers, retainedCallIds);
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

  return { role: msg.role, content: blocks.length ? blocks : [{ type: "text", text: "[Earlier MCP steps omitted: the server configuration changed.]" }] };
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
