import { catalogIdentity } from "./model-catalog";
import { requestUrl } from "obsidian";
import type {
  ChatSettings,
  UnifiedMessage,
  UnifiedToolDef,
  UnifiedResponse,
  ContentBlock,
} from "../types";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";

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
  const model = settings.model || "claude-sonnet-4-6";
  const identity = await catalogIdentity("anthropic", settings.apiKey);
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
    messages: messages.map(msg => toAnthropicMessage(msg, model, identity)),
  };

  // Opus 4.7+ rejects manual thinking. Keep older models on their budget mode.
  const generation = model.match(/^claude-(?:sonnet|opus)-(\d+)[-.](\d{1,2})(?:-|$)/);
  const supportsAdaptive = !!generation && (Number(generation[1]) > 4 ||
    (Number(generation[1]) === 4 && Number(generation[2]) >= 6));
  const supportsThinking = model.includes("claude-sonnet-4") || model.includes("claude-opus") || model.includes("claude-sonnet-3-7");

  if (supportsAdaptive) {
    // Adaptive: Claude decides when/how much to think per request
    body.thinking = { type: "adaptive" };
  } else if (supportsThinking) {
    // Manual: fixed budget for older models
    body.thinking = { type: "enabled", budget_tokens: 8192 };
  }

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

  let response;
  try {
    response = await requestUrl({
      url: ANTHROPIC_API_URL,
      method: "POST",
      headers: {
        "x-api-key": settings.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
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
    throw new Error(`Anthropic API error (${response.status}): ${errorText}`);
  }

  const data = parseAnthropicResponse(response.json as unknown);

  return {
    content: data.content
      .map(fromAnthropicBlock)
      .filter((b): b is ContentBlock => b !== null),
    // Thinking signatures, redacted thinking, citations and server tool results
    // must be returned unchanged. UI content is deliberately separate.
    replay: { provider: "anthropic", model, identity, items: data.content },
    stopReason: normalizeStopReason(data.stop_reason),
    usage: data.usage
      ? { inputTokens: data.usage.input_tokens ?? 0, outputTokens: data.usage.output_tokens ?? 0 }
      : undefined,
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
  search_results?: Array<{ title: string; url: string; snippet: string }>;
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

function toAnthropicMessage(msg: UnifiedMessage, model: string, identity: string): Record<string, unknown> {
  if (msg.role === "assistant" && msg.replay?.provider === "anthropic" && (!msg.replay.model || msg.replay.model === model) && (!msg.replay.identity || msg.replay.identity === identity)) {
    return { role: msg.role, content: msg.replay.items };
  }
  if (typeof msg.content === "string") {
    return { role: msg.role, content: msg.content };
  }

  // Content blocks (tool_use responses from assistant, tool_result from user)
  const blocks = msg.content.map((block) => {
    if (block.type === "tool_result") {
      return {
        type: "tool_result",
        tool_use_id: block.tool_use_id,
        content: block.content,
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
      return {
        type: "image",
        source: {
          type: "base64",
          media_type: block.image.mediaType,
          data: block.image.data,
        },
      };
    }
    return { type: "text", text: block.text };
  }).filter((b) => !(b.type === "text" && !b.text));

  return { role: msg.role, content: blocks };
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
  // Web search results are server-managed; render as text for the user
  if (block.type === "web_search_tool_result" && block.search_results) {
    const formatted = block.search_results
      .map((r) => `**${r.title}**\n${r.url}\n${r.snippet}`)
      .join("\n\n");
    return { type: "text", text: formatted };
  }
  // Thinking and server_tool_use blocks are internal; don't surface to user
  if (block.type === "thinking" || block.type === "server_tool_use") {
    return null;
  }
  // Skip blocks with no text content (safety net)
  if (!block.text) {
    return null;
  }
  return { type: "text", text: block.text };
}
