import type { ConversationRecord } from "./chat-state";
import type { FileAttachment, ImageAttachment } from "./types";

/** JSON attachment bytes across all conversations, not a per-chat allowance. */
export const MAX_HISTORY_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const sizes = new WeakMap<object, { data: string; text: string; bytes: number }>();

/** UTF-8 JSON string size without constructing a large JSON string or byte array. */
function stringBytes(text: string): number {
  let size = 2;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 32) size += [8, 9, 10, 12, 13].includes(c) ? 2 : 6;
    else if (c === 34 || c === 92) size += 2;
    else if (c < 128) size++;
    else if (c < 2048) size += 2;
    else if (c >= 0xd800 && c <= 0xdbff && text.charCodeAt(i + 1) >= 0xdc00 && text.charCodeAt(i + 1) <= 0xdfff) { size += 4; i++; }
    else size += c >= 0xd800 && c <= 0xdfff ? 6 : 3;
  }
  return size;
}

export function retainedAttachmentBytes(item: ImageAttachment | FileAttachment): number {
  const text = "text" in item ? item.text ?? "" : "";
  const cached = sizes.get(item);
  const bytes = cached?.data === item.data && cached.text === text ? cached.bytes : stringBytes(item.data) + stringBytes(text);
  sizes.set(item, { data: item.data, text, bytes });
  // Metadata and property-name overhead, including escaped/Unicode file names.
  return bytes + stringBytes(item.id) + stringBytes(item.fileName) + stringBytes(item.mediaType) + 128;
}

/** Count payloads as the shared retention pass does, including legacy UI-only data. */
export function conversationAttachmentBytes(conversation: ConversationRecord): number {
  let bytes = 0;
  const ids = new Set<string>();
  const count = (item: ImageAttachment | FileAttachment) => { ids.add(item.id); bytes += retainedAttachmentBytes(item); };
  for (const message of conversation.agentMessages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.image) count(block.image);
      if (block.file) count(block.file);
      for (const item of [...block.images ?? [], ...block.files ?? []]) count(item);
    }
  }
  for (const entry of conversation.chatHistory) {
    for (const item of [...entry.images ?? [], ...entry.attachedFiles ?? []]) {
      if (!ids.has(item.id) && (item.data || ("text" in item && item.text))) count(item);
    }
  }
  return bytes;
}

/** Mutates retained history in place to preserve entry identities and in-flight
 * tool-result arrays. Only attachment payloads expire, never conversation text.
 */
export function boundConversationAttachments(conversations: ConversationRecord[], activeId: string, limit = MAX_HISTORY_ATTACHMENT_BYTES,
  /** Chats unchanged since read or saved: counted first, never stripped (reading a chat doesn't change its file). */
  unchanged: ReadonlySet<string> = new Set()): { changed: Set<string>; omitted: number } {
  let remaining = limit;
  let omitted = 0;
  const changed = new Set<string>();
  const ordered = [...conversations].sort((a, b) => Number(unchanged.has(b.id)) - Number(unchanged.has(a.id)) ||
    Number(b.id === activeId) - Number(a.id === activeId) || b.updatedAt - a.updatedAt);
  const accepted = new Map<ConversationRecord, Map<string, ImageAttachment | FileAttachment>>();
  const seen = new Map<ConversationRecord, Set<string>>();
  let whole = false;
  const keep = (item: ImageAttachment | FileAttachment): boolean => {
    if (whole) {
      remaining -= retainedAttachmentBytes(item);
      return true;
    }
    // Lower bound first: don't scan payloads that provably cannot fit.
    const text = "text" in item ? item.text ?? "" : "";
    if (item.data.length + text.length > remaining) return false;
    const bytes = retainedAttachmentBytes(item);
    if (bytes > remaining) return false;
    remaining -= bytes;
    return true;
  };
  const missing = (names: string[]) => `[Attachment data omitted from older chat history to stay within the shared retention budget: ${names.join(", ")}. Reattach the file if needed.]`;
  for (const conversation of ordered) {
    whole = unchanged.has(conversation.id);
    const blobs = new Map<string, ImageAttachment | FileAttachment>();
    const ids = new Set<string>();
    accepted.set(conversation, blobs);
    seen.set(conversation, ids);
    for (const message of [...conversation.agentMessages].reverse()) {
      if (typeof message.content === "string") continue;
      for (let i = message.content.length - 1; i >= 0; i--) {
        const block = message.content[i];
        if ((block.type === "image" && block.image) || (block.type === "file" && block.file)) {
          const item = block.image ?? block.file!;
          ids.add(item.id);
          if (keep(item)) blobs.set(item.id, item);
          else {
            message.content[i] = { type: "text", text: missing([item.fileName]) };
            delete message.replay;
            changed.add(conversation.id);
            omitted++;
          }
        } else if (block.type === "tool_result") {
          const expired: string[] = [];
          const retain = <T extends ImageAttachment | FileAttachment>(items: T[]): T[] => items.filter(item => {
            if (keep(item)) return true;
            expired.push(item.fileName);
            return false;
          });
          if (block.images?.length) block.images = retain(block.images);
          if (block.files?.length) block.files = retain(block.files);
          if (expired.length) {
            block.content = `${block.content ?? ""}\n${missing(expired)}`;
            delete message.replay;
            changed.add(conversation.id);
            omitted += expired.length;
          }
        }
      }
    }
  }
  for (const conversation of ordered) {
    whole = unchanged.has(conversation.id);
    const blobs = accepted.get(conversation)!;
    const ids = seen.get(conversation)!;
    for (const entry of [...conversation.chatHistory].reverse()) {
      const restore = <T extends ImageAttachment | FileAttachment>(item: T): T => {
        const retained = blobs.get(item.id);
        if (retained) return retained as T;
        const hasData = !!item.data || ("text" in item && !!item.text);
        // Legacy visible-only attachments can live for this session, within
        // the same budget. Saved UI rows still contain metadata only.
        if (!ids.has(item.id) && hasData && keep(item)) { blobs.set(item.id, item); return item; }
        if (!hasData) return item;
        changed.add(conversation.id);
        if (!ids.has(item.id)) omitted++;
        const { text: _text, ...metadata } = item as FileAttachment;
        return { ...metadata, data: "" } as T;
      };
      if (entry.images?.length) entry.images = entry.images.map(restore);
      if (entry.attachedFiles?.length) entry.attachedFiles = entry.attachedFiles.map(restore);
    }
  }
  return { changed, omitted };
}
