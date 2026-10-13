import type { ChatHistoryEntry, ContentBlock, UnifiedMessage } from "../types";

/**
 * A user message that starts a turn. Tool results never do, also with a
 * message the user added to the running turn next to them (steering):
 * cutting there would orphan the results.
 */
function startsUserTurn(message: UnifiedMessage): boolean {
  if (message.role !== "user") return false;
  if (typeof message.content === "string") return true;
  return !message.content.some(block => block.type === "tool_result") &&
    message.content.some(block => block.type === "text" || block.type === "image");
}

/**
 * API messages kept per conversation: sent, saved and restored. Trimming
 * keeps whole user turns, so a long turn can keep a few more.
 */
export const MAX_CONVERSATION_LENGTH = 80;

/** Keep whole user turns so pruning/persistence cannot orphan tool results. */
export function trimHistory(messages: UnifiedMessage[], limit: number): UnifiedMessage[] {
  const firstTurn = messages.findIndex(startsUserTurn);
  if (firstTurn < 0) return [];
  let start = firstTurn;
  const cutoff = Math.max(0, messages.length - limit);
  for (let index = firstTurn; index <= cutoff; index++) {
    if (startsUserTurn(messages[index])) start = index;
  }
  return start === 0 ? messages : messages.slice(start);
}

/** Tool results of the last 2 user turns keep their images and files when sent. */
export const TOOL_IMAGE_TURNS = 2;

/**
 * The history as sent to a provider: tool results older than the last
 * `turns` user turns lose their images (`view_image`, `view_canvas`) and
 * files (`read_file` on a PDF) and say so in their text, so a full replay
 * doesn't send every image or file again. What the user attached stays.
 * Nothing is changed in place; unchanged messages are the same objects.
 */
export function withoutOldToolImages(messages: UnifiedMessage[], turns = TOOL_IMAGE_TURNS): UnifiedMessage[] {
  let cutoff = -1;
  for (let index = messages.length - 1, seen = 0; index >= 0; index--) {
    if (startsUserTurn(messages[index]) && ++seen === turns) {
      cutoff = index;
      break;
    }
  }
  const toolNames = new Map<string, string>();
  for (const message of messages.slice(0, Math.max(cutoff, 0))) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type === "tool_use" && block.id && block.name) toolNames.set(block.id, block.name);
    }
  }
  const hasMedia = (block: ContentBlock) => block.type === "tool_result" && !!(block.images?.length || block.files?.length);
  return messages.map((message, index) => {
    if (index >= cutoff || typeof message.content === "string" || !message.content.some(hasMedia)) return message;
    return {
      ...message,
      content: message.content.map((block): ContentBlock => {
        if (!hasMedia(block)) return block;
        const { images = [], files = [], ...rest } = block;
        const what = [
          ...(images.length ? [images.length === 1 ? "image" : `${images.length} images`] : []),
          ...(files.length ? [files.length === 1 ? "file" : `${files.length} files`] : []),
        ].join(" and ");
        const tool = toolNames.get(block.tool_use_id ?? "") ?? "a tool";
        const note = `[${what} from ${tool} omitted to save context]`;
        return { ...rest, content: rest.content ? `${rest.content}\n\n${note}` : note };
      }),
    };
  });
}

let turnCount = 0;

/** A new ID for a user turn. */
export function newTurnId(): string {
  return `turn-${Date.now().toString(36)}-${(turnCount++).toString(36)}`;
}

/**
 * The agent history up to just before the turn `turnId`, as a new array
 * (so the OpenAI adapter can't chain to a response from the cut-off part).
 * A turn that isn't there was trimmed away, since every turn goes into both
 * histories: all of the history comes after it, and nothing is kept.
 */
export function cutBeforeTurn(messages: UnifiedMessage[], turnId: string): UnifiedMessage[] {
  const index = messages.findIndex(message => message.turnId === turnId && startsUserTurn(message));
  return index < 0 ? messages : messages.slice(0, index);
}

/**
 * Turn `turnId` can be edited or answered again: the API history still
 * holds it. A turn cut off by the history's limit can't: cutting there
 * would leave the model without the whole chat.
 */
export function editableTurn(messages: UnifiedMessage[], turnId: string): boolean {
  return messages.some(message => message.turnId === turnId && startsUserTurn(message));
}

/** The text a user turn was sent with: context first, the user's text last. */
function sentText(message: UnifiedMessage): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.map(block => block.type === "text" ? block.text ?? "" : "").join("");
}

/**
 * Gives a chat saved before turn IDs existed matching IDs in both
 * histories, in place; a chat that has any turn ID is left as it is. Each
 * turn added one user entry to the view's history and one turn start to
 * the agent's, so they are paired from the end. A user entry whose text
 * doesn't end the turn start's text is an `ask_user` answer, no turn of its
 * own: it gets no ID. Entries older than the (trimmed) agent history get
 * IDs of their own. Only IDs are added; nothing else changes.
 */
export function assignLegacyTurnIds(entries: ChatHistoryEntry[], messages: UnifiedMessage[]): void {
  if (entries.some(entry => entry.turnId) || messages.some(message => message.turnId)) return;
  const starts = messages.filter(startsUserTurn);
  let start = starts.length - 1;
  let count = 0;
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type !== "user") continue;
    if (start < 0) {
      entry.turnId = `legacy-${++count}`;
      continue;
    }
    const sent = sentText(starts[start]);
    const text = entry.text ?? "";
    if (sent !== text && !sent.endsWith(`\n\n${text}`)) continue;
    entry.turnId = starts[start].turnId = `legacy-${++count}`;
    start--;
  }
}
