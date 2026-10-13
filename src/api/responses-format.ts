import type { ContentBlock, FileAttachment, ImageAttachment, McpServer, Provider, StreamOptions, TokenUsage, UnifiedMessage, UnifiedResponse } from "../types";
import { ProviderError, StreamCutError } from "./errors";
import { streamSSE, type StreamResult } from "./stream";
import { isRecord } from "../json";
import { withoutOldToolImages } from "../agent/history";
import { afterCompaction } from "../agent/compaction";
import { fileAsText, isSentAsFile } from "../files/attachments";
import { openaiServerCalls, withServerCalls, withoutGoneServerCalls } from "./mcp";

/** A failure the stream reported (`error`, `response.failed`). */
export interface ResponsesFailure {
  message: string;
  code?: string;
}

/** The adapter's errors for an HTTP error answer and for a failure inside the stream. */
export interface ResponsesErrors {
  http(response: StreamResult): Error;
  stream(failure: ResponsesFailure): Error;
}

/**
 * Sends a streamed Responses request (OpenAI, and the ChatGPT account's
 * Codex route with its own headers); returns the completed response as the
 * non-streamed API would. `name` names the provider in the error for a
 * stream that ends too early.
 */
export async function sendResponsesRequest(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  stream: StreamOptions,
  name: string,
  errors: ResponsesErrors,
): Promise<Record<string, unknown>> {
  const collected = collectResponsesStream(stream.onTextDelta);
  const response = await streamSSE(url, { headers, body: JSON.stringify(body) }, collected.onEvent, stream.signal);
  if (response.status < 200 || response.status >= 300) throw errors.http(response);
  const { data, failure } = collected.finish();
  if (failure) throw errors.stream(failure);
  if (!data) throw new StreamCutError(name);
  return data;
}

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
  const replayable = (message: UnifiedMessage) => message.role === "assistant" && message.replay?.provider === provider &&
    (!model || !message.replay.model || message.replay.model === model) && (!identity || !message.replay.identity || message.replay.identity === identity);
  // After a compaction, from its message on.
  for (const message of withoutOldToolImages(afterCompaction(messages, replayable))) {
    if (replayable(message) && message.replay) {
      // Items before the latest compaction item are covered by it.
      const replayed = withoutGoneServerCalls(message.replay.items, servers);
      const last = replayed.map((item) => item.type).lastIndexOf("compaction");
      items.push(...(last > 0 ? replayed.slice(last) : replayed));
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
  if (data.status === "failed" || data.error) {
    const error = isRecord(data.error) ? data.error : {};
    // Status 0: the error came inside a response; its code decides on a retry.
    throw new ProviderError(typeof error.message === "string" ? error.message : "Response failed.", 0,
      typeof error.code === "string" ? error.code : undefined);
  }
  const output = Array.isArray(data.output) ? data.output.filter(isRecord) : [];
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
    usage: usage ? responsesUsage(usage) : undefined,
    // Tools OpenAI called on MCP servers; their items stay in the replay as sent.
    ...withServerCalls(openaiServerCalls(output)),
    // Server-side compaction: its item is encrypted, so no readable summary.
    ...(output.some((item) => item.type === "compaction") ? { compaction: {} } : {}),
  };
}

/**
 * Server-side compaction: the server compacts when a request's context
 * crosses `threshold` and returns an encrypted compaction item.
 */
export function compactionParameter(threshold: number | undefined): Record<string, unknown> {
  return threshold ? { context_management: [{ type: "compaction", compact_threshold: threshold }] } : {};
}

/** Responses API usage: `input_tokens` includes the cached ones (`input_tokens_details.cached_tokens`). */
function responsesUsage(usage: Record<string, unknown>): TokenUsage {
  const details = isRecord(usage.input_tokens_details) ? usage.input_tokens_details : {};
  const cached = numberValue(details.cached_tokens);
  return {
    inputTokens: numberValue(usage.input_tokens),
    outputTokens: numberValue(usage.output_tokens),
    ...(cached ? { cachedInputTokens: cached } : {}),
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

/**
 * Collects a streamed Responses answer (`stream: true`). Text deltas go to
 * `onTextDelta` as they arrive. The response is rebuilt from the
 * `response.output_item.done` items (messages, tool calls, reasoning,
 * search and MCP items alike), because `response.completed` may carry an
 * empty `output` (always on the Codex route with `store: false`); the
 * terminal event gives id, status and usage. `finish()` returns the same
 * object the non-streamed API returns, or the failure the stream reported.
 */
function collectResponsesStream(onTextDelta?: (text: string) => void): {
  onEvent: (event: Record<string, unknown>) => void;
  finish: () => { data?: Record<string, unknown>; failure?: ResponsesFailure };
} {
  const items = new Map<string | number, Record<string, unknown>>();
  let completed: Record<string, unknown> | undefined;
  let failure: ResponsesFailure | undefined;
  return {
    onEvent: (event) => {
      const type = event.type;
      if (type === "response.output_text.delta") {
        // The markers' characters go; their words are dropped from the whole text at the end.
        if (typeof event.delta === "string" && event.delta) onTextDelta?.(event.delta.replace(CITATION_CHARACTERS, ""));
      } else if (type === "response.output_item.done") {
        if (isRecord(event.item)) {
          const index = event.output_index;
          const key = typeof index === "number" || typeof index === "string" ? index
            : typeof event.item.id === "string" ? event.item.id : items.size;
          items.set(key, event.item);
        }
      } else if (type === "response.completed") {
        completed = isRecord(event.response) ? event.response : {};
      } else if (type === "response.incomplete") {
        completed = { ...(isRecord(event.response) ? event.response : {}), status: "incomplete" };
      } else if (type === "response.failed") {
        const error = isRecord(event.response) && isRecord(event.response.error) ? event.response.error : {};
        failure = {
          message: typeof error.message === "string" ? error.message : "Response failed.",
          code: typeof error.code === "string" ? error.code : undefined,
        };
      } else if (type === "error" && typeof event.message === "string") {
        failure = { message: event.message, code: typeof event.code === "string" ? event.code : undefined };
      }
    },
    finish: () => {
      if (failure) return { failure };
      if (!completed) return {};
      return { data: { ...completed, output: items.size > 0 ? Array.from(items.values()) : completed.output ?? [] } };
    },
  };
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}
