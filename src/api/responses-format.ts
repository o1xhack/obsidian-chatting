import type { ContentBlock, FileAttachment, ImageAttachment, McpServer, Provider, UnifiedMessage, UnifiedResponse } from "../types";
import { ProviderError } from "./errors";
import { withoutOldToolImages } from "../agent/history";
import { fileAsText, isSentAsFile } from "../files/attachments";
import { openaiServerCalls, withServerCalls, withoutGoneServerCalls } from "./mcp";

/** Encode both fresh input and restored history without losing tool pairs. */
export function buildResponsesInput(
  messages: UnifiedMessage[],
  provider: Extract<Provider, "openai" | "chatgpt-oauth">,
  model?: string,
  identity?: string,
  /** The MCP servers of this request; calls of others aren't replayed. */
  servers: McpServer[] = [],
): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const message of withoutOldToolImages(messages)) {
    if (message.role === "assistant" && message.replay?.provider === provider && (!model || !message.replay.model || message.replay.model === model) && (!identity || !message.replay.identity || message.replay.identity === identity)) {
      items.push(...withoutGoneServerCalls(message.replay.items, servers, message.replay.mcpServers));
      continue;
    }
    const content: Record<string, unknown>[] = [];
    const flush = () => {
      if (content.length) {
        items.push({ type: "message", role: message.role, content: content.splice(0) });
      }
    };
    const blocks: ContentBlock[] = typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content;
    for (const block of blocks) {
      if (block.type === "text" && block.text) {
        content.push(message.role === "assistant"
          ? { type: "output_text", text: block.text, annotations: [] }
          : { type: "input_text", text: block.text });
      } else if (block.type === "image" && block.image && message.role === "user") {
        content.push(inputImage(block.image));
      } else if (block.type === "file" && block.file && message.role === "user") {
        content.push(inputFile(block.file));
      } else if (block.type === "tool_use" && block.id && block.name) {
        flush();
        items.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
      } else if (block.type === "tool_result" && block.tool_use_id) {
        flush();
        items.push({ type: "function_call_output", call_id: block.tool_use_id, output: functionOutput(block) });
      }
    }
    flush();
  }
  return items;
}

/**
 * A tool result's `output`. With images or files it is a content array: the
 * Responses API allows `output` to be a string or a list of `input_text`,
 * `input_image` and `input_file` items (function_call_output in the API
 * reference). The ChatGPT route takes the same request format, so both
 * providers get the image or file inside the result rather than in an
 * extra user message.
 */
function functionOutput(block: ContentBlock): string | Record<string, unknown>[] {
  const text = block.content ?? "";
  if (!block.images?.length && !block.files?.length) return text;
  return [
    { type: "input_text", text: text || "(attached)" },
    ...(block.images ?? []).map(inputImage),
    ...(block.files ?? []).map(inputFile),
  ];
}

function inputImage(image: ImageAttachment): Record<string, unknown> {
  return { type: "input_image", image_url: `data:${image.mediaType};base64,${image.data}`, detail: "auto" };
}

/**
 * A file: PDF and Office files as `input_file` with inline base64 data (the
 * model reads them itself, PDFs with their page images), text files as text.
 */
function inputFile(file: FileAttachment): Record<string, unknown> {
  if (isSentAsFile(file)) {
    return { type: "input_file", filename: file.fileName, file_data: `data:${file.mediaType};base64,${file.data}` };
  }
  return { type: "input_text", text: fileAsText(file) };
}

/** Preserve native reasoning/search/refusal items even when they have no UI block. */
export function fromResponsesOutput(
  data: Record<string, unknown>,
  provider: Extract<Provider, "openai" | "chatgpt-oauth">,
  model?: string,
  identity?: string,
): UnifiedResponse {
  const output = Array.isArray(data.output) ? data.output.filter(isRecord) : [];
  if (data.status === "failed" || data.error) {
    const error = isRecord(data.error) ? data.error : {};
    const remoteEffectsPossible = output.some(item => item.type === "mcp_call");
    // Status 0: the error came inside a response; its code decides on a retry.
    throw new ProviderError((typeof error.message === "string" ? error.message : "Response failed.") +
      (remoteEffectsPossible ? " Remote MCP tools may already have run; check their results before retrying." : ""), 0,
      typeof error.code === "string" ? error.code : undefined, undefined, remoteEffectsPossible);
  }
  const content: ContentBlock[] = [];
  for (const item of output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content.filter(isRecord)) {
        if (part.type === "output_text" && typeof part.text === "string") {
          content.push({ type: "text", text: withoutCitationMarkers(part.text) });
        } else if (part.type === "refusal" && typeof part.refusal === "string") {
          content.push({ type: "text", text: part.refusal });
        }
      }
    } else if (item.type === "function_call" && data.status !== "incomplete") {
      if (typeof item.call_id !== "string" || typeof item.name !== "string") {
        throw new Error("Response contained an invalid tool call.");
      }
      const raw = typeof item.arguments === "string" ? item.arguments : "";
      let input: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(raw);
        input = isRecord(parsed) ? parsed : { _raw: raw };
      } catch {
        input = { _raw: raw };
      }
      content.push({ type: "tool_use", id: item.call_id, name: item.name, input });
    }
  }
  const usage = isRecord(data.usage) ? data.usage : undefined;
  return {
    content,
    replay: { provider, model, identity, items: output },
    stopReason: data.status === "incomplete" ? "max_tokens" : content.some(block => block.type === "tool_use") ? "tool_use" : "end_turn",
    usage: usage ? { inputTokens: numberValue(usage.input_tokens), outputTokens: numberValue(usage.output_tokens) } : undefined,
    // Tools OpenAI called on MCP servers; their items stay in the replay as sent.
    ...withServerCalls(openaiServerCalls(output)),
  };
}

/**
 * Citation markers some models write into the text after a web search
 * (seen on the ChatGPT route: "citeturn0search0" between private-use
 * characters, a reference to a search result) instead of `annotations`.
 * They are left out of the shown text; the replay items keep them as sent.
 */
const CITATION_MARKER = / ?\uE200[^\uE201]*\uE201/g;
const CITATION_CHARACTERS = /[\uE200-\uE202]/g;

export function withoutCitationMarkers(text: string): string {
  return text.replace(CITATION_MARKER, "").replace(CITATION_CHARACTERS, "");
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
