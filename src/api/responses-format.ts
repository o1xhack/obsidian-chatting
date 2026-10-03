import type { ContentBlock, Provider, UnifiedMessage, UnifiedResponse } from "../types";

/** Encode both fresh input and restored history without losing tool pairs. */
export function buildResponsesInput(
  messages: UnifiedMessage[],
  provider: Extract<Provider, "openai" | "chatgpt-oauth">,
  model?: string,
  identity?: string,
): Record<string, unknown>[] {
  const items: Record<string, unknown>[] = [];
  for (const message of messages) {
    if (message.role === "assistant" && message.replay?.provider === provider && (!model || !message.replay.model || message.replay.model === model) && (!identity || !message.replay.identity || message.replay.identity === identity)) {
      items.push(...message.replay.items);
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
        content.push({ type: "input_image", image_url: `data:${block.image.mediaType};base64,${block.image.data}`, detail: "auto" });
      } else if (block.type === "tool_use" && block.id && block.name) {
        flush();
        items.push({ type: "function_call", call_id: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}) });
      } else if (block.type === "tool_result" && block.tool_use_id) {
        flush();
        items.push({ type: "function_call_output", call_id: block.tool_use_id, output: block.content ?? "" });
      }
    }
    flush();
  }
  return items;
}

/** Preserve native reasoning/search/refusal items even when they have no UI block. */
export function fromResponsesOutput(
  data: Record<string, unknown>,
  provider: Extract<Provider, "openai" | "chatgpt-oauth">,
  model?: string,
  identity?: string,
): UnifiedResponse {
  if (data.status === "failed" || data.error) {
    const error = isRecord(data.error) ? data.error.message : undefined;
    throw new Error(typeof error === "string" ? error : "Response failed.");
  }
  const output = Array.isArray(data.output) ? data.output.filter(isRecord) : [];
  const content: ContentBlock[] = [];
  for (const item of output) {
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content.filter(isRecord)) {
        if (part.type === "output_text" && typeof part.text === "string") {
          content.push({ type: "text", text: part.text });
        } else if (part.type === "refusal" && typeof part.refusal === "string") {
          content.push({ type: "text", text: part.refusal });
        }
      }
    } else if (item.type === "function_call" && data.status !== "incomplete") {
      const input: unknown = JSON.parse(typeof item.arguments === "string" ? item.arguments : "{}");
      if (!isRecord(input) || typeof item.call_id !== "string" || typeof item.name !== "string") {
        throw new Error("Response contained an invalid tool call.");
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
  };
}

function numberValue(value: unknown): number {
  return typeof value === "number" ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
