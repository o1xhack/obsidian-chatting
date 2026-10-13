import type { ContentBlock, UnifiedMessage } from "../types";
import { ProviderError } from "../api/errors";

/**
 * The plugin's own summary of a conversation, where the provider doesn't
 * compact or its compaction can't be read by the provider now in use: a
 * request with the conversation as a plain transcript and this
 * instruction, no tools.
 */

export const SUMMARY_SYSTEM_PROMPT = "You write summaries of conversations between a user and an AI assistant working in the user's Obsidian vault. The summary replaces the conversation, so the assistant can continue from it alone.";

const SUMMARY_INSTRUCTION = `Summarize the conversation below so that you can continue it without the original messages. Keep:
- what the user wants, their preferences and instructions;
- decisions and results so far, with the exact names of notes, files, headings and values that matter;
- what was changed in the vault;
- open questions and the next steps.
Leave out greetings and small talk. Write plain Markdown, at most about 600 words.`;

/** Without a known window: what most models take. */
const DEFAULT_TRANSCRIPT_TOKENS = 50000;

/**
 * Tokens of `text`, estimated high so a transcript fits: about 3 ASCII
 * characters per token, and a token for each other character (Chinese,
 * Japanese and many others take about one).
 */
function tokenCost(code: number): number {
  return code < 128 ? 1 / 3 : 1;
}
const TOOL_INPUT_CHARS = 300;
const TOOL_RESULT_CHARS = 1000;

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function blockText(block: ContentBlock): string {
  switch (block.type) {
    case "text":
      return block.text ?? "";
    case "image":
      return `[image: ${block.image?.fileName ?? "image"}]`;
    case "file":
      return `[file: ${block.file?.fileName ?? "file"}]`;
    case "tool_use":
      return `[tool call ${block.name ?? ""}: ${cut(JSON.stringify(block.input ?? {}), TOOL_INPUT_CHARS)}]`;
    case "tool_result":
      return `[tool result${block.is_error ? " (error)" : ""}: ${cut(block.content ?? "", TOOL_RESULT_CHARS)}]`;
  }
}

/** The conversation as text, its end kept when it is estimated at more than `maxTokens`. */
export function transcript(messages: UnifiedMessage[], maxTokens: number): string {
  const lines = messages.map((message) => {
    const text = typeof message.content === "string" ? message.content : message.content.map(blockText).filter(Boolean).join("\n");
    const summary = message.compaction?.summary ? `[Summary of what came before:]\n${message.compaction.summary}\n` : "";
    return `${message.role === "user" ? "User" : "Assistant"}: ${summary}${text}`;
  });
  const all = lines.join("\n\n");
  let tokens = 0;
  let start = all.length;
  while (start > 0 && tokens + tokenCost(all.charCodeAt(start - 1)) <= maxTokens) {
    start--;
    tokens += tokenCost(all.charCodeAt(start));
  }
  if (start === 0) return all;
  // Not inside a surrogate pair.
  if (start < all.length && /[\uDC00-\uDFFF]/.test(all[start])) start++;
  return `(The beginning of the conversation is left out.)\n…${all.slice(start)}`;
}

/** The summary request for `messages`, its transcript sized to half the window. */
export function summaryRequest(messages: UnifiedMessage[], contextWindow: number | undefined): string {
  const maxTokens = contextWindow ? Math.floor(contextWindow * 0.5) : DEFAULT_TRANSCRIPT_TOKENS;
  return `${SUMMARY_INSTRUCTION}\n\n<conversation>\n${transcript(messages, maxTokens)}\n</conversation>`;
}

/** An error that says the request didn't fit the model's context. */
export function isContextOverflow(error: unknown): boolean {
  if (!(error instanceof ProviderError)) return false;
  return error.code === "context_length_exceeded" ||
    /prompt is too long|context[ _]length|maximum context|context window|too many (input )?tokens/i.test(error.message);
}
