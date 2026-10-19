import { type ModelOption, cachedCatalog, catalogIdentity, catalogModel, resolveThinkingLevel } from "./model-catalog";
import { requestUrl } from "obsidian";
import { serializeRequest } from "./request-budget";
import { ProviderError, retryAfterMs } from "./errors";
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
 * Sends a message to the Anthropic Messages API via requestUrl().
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
  systemPrompt: string
): Promise<UnifiedResponse> {
  const model = settings.model;
  const identity = await catalogIdentity("anthropic", settings.apiKey);
  const servers = activeServers(settings).map(server => ({ ...server }));
  if (settings.modelCatalog) {
    cachedCatalog(settings.modelCatalog, "anthropic", identity);
  }
  const body: Record<string, unknown> = {
    model,
    max_tokens: 16384,
    // System prompt as a content block with cache_control breakpoint.
    // Anthropic caches everything up to the breakpoint across requests.
    system: [
      {
        type: "text",
        text: systemPrompt,
        cache_control: { type: "ephemeral" },
      },
    ],
    messages: withoutOldToolImages(messages).map(msg => toAnthropicMessage(msg, model, identity, servers)),
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
  let response;
  try {
    response = await requestUrl({
      url: ANTHROPIC_API_URL,
      method: "POST",
      headers: {
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
        ...(servers.length ? { "anthropic-beta": ANTHROPIC_MCP_BETA } : {}),
      },
      body: requestBody,
      throw: false,
    });
  } catch (e: unknown) {
    // requestUrl throws on network errors; extract API details if available
    const err = asRecord(e);
    const status = typeof err.status === "number" ? err.status : "unknown";
    const apiMsg = getNestedString(err, ["json", "error", "message"]);
    if (apiMsg) {
      throw new Error(`Anthropic API error (${status}): ${apiMsg}`);
    }
    throw e;
  }

  if (response.status !== 200) {
    const responseJson = response.json as unknown;
    const errorText = getNestedString(responseJson, ["error", "message"]) ?? `HTTP ${response.status}`;
    throw new ProviderError(`Anthropic API error (${response.status}): ${errorText}`, response.status,
      getNestedString(responseJson, ["error", "type"]), retryAfterMs(response.headers));
  }

  const data = parseAnthropicResponse(response.json as unknown);
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

function toAnthropicMessage(msg: UnifiedMessage, model: string, identity: string, servers: McpServer[]): Record<string, unknown> {
  if (msg.role === "assistant" && msg.replay?.provider === "anthropic" && (!msg.replay.model || msg.replay.model === model) && (!msg.replay.identity || msg.replay.identity === identity)) {
    const content = withoutGoneServerCalls(msg.replay.items, servers, msg.replay.mcpServers);
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
