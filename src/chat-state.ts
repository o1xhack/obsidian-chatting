/**
 * The saved chats (`chat-state.json`): the conversation records, their
 * format, the one-time migrations from older formats, and saving each
 * attached image and file once. Pure functions; `main.ts` reads and writes
 * the file.
 */
import { historySelection } from "./selection-history";
import type { ChatHistoryEntry, FileAttachment, ImageAttachment, UnifiedMessage } from "./types";
import { assignLegacyTurnIds, trimHistory, withoutOldToolImages, withoutLargeToolText, withoutLargeVisibleToolText, boundedToolText, MAX_CONVERSATION_LENGTH } from "./agent/history";

/** Current format version of `chat-state.json`. */
export const CHAT_STATE_VERSION = 3;

/** Saved per conversation: the last 100 visible entries (and `MAX_CONVERSATION_LENGTH` API messages). */
export const SAVED_ENTRIES = 100;

/** The title of a conversation without a user message yet. */
export const NEW_CHAT_TITLE = "New chat";
const TITLE_LENGTH = 40;

/** One conversation, in memory and as saved. */
export interface ConversationRecord {
  id: string;
  /** The first user message (shortened) until renamed. */
  title: string;
  /** Original automatic title survives pruning, including while a custom name is shown. */
  automaticTitle?: string;
  /** null: the original source is no longer identifiable in retained history. */
  titleSourceTurnId?: string | null;
  /** Set when the user renamed the conversation; the title then stays. */
  customTitle: boolean;
  createdAt: number;
  /** When a turn last started or the conversation was cleared; orders the list. */
  updatedAt: number;
  /** Visible history; saved with images and files without their data. */
  chatHistory: ChatHistoryEntry[];
  /** API history; the only place with image and file data. */
  agentMessages: UnifiedMessage[];
  /** For the model with the next turn: what the user did meanwhile (e.g. undid an answer's changes). */
  notes?: string[];
  /**
   * Typed after its turn's last step while it ran in the background: they
   * run when the chat is shown again (optional, so no new format version).
   */
  pendingMessages?: string[];
}

/** `chat-state.json` as this version writes it. */
export interface ChatState {
  version: number;
  /** When it was written (ms); tells the newer of the two copies. */
  savedAt: number;
  /** The conversation the chat shows; opened again on the next start. */
  activeConversationId: string;
  conversations: ConversationRecord[];
}

type StateRecord = Record<string, unknown>;

/**
 * One-time repairs of the saved chat, keyed by the version they upgrade
 * from (a file without `version` is version 1). Each runs once: the next
 * save writes the new version.
 */
const CHAT_STATE_MIGRATIONS: Record<number, (state: StateRecord) => StateRecord> = {
  // 1 → 2: turn IDs for chats saved without them. Image data the file
  // still has stays for this session; the next save keeps it only in the
  // API history.
  1: (state) => {
    const chatHistory = arrayOf<ChatHistoryEntry>(state.chatHistory);
    const agentMessages = arrayOf<UnifiedMessage>(state.agentMessages);
    assignLegacyTurnIds(chatHistory, agentMessages);
    return { ...state, version: 2, chatHistory, agentMessages };
  },
  // 2 → 3: the single chat becomes the first (and active) conversation.
  2: (state) => {
    const conversation = newConversation();
    conversation.chatHistory = arrayOf<ChatHistoryEntry>(state.chatHistory);
    conversation.agentMessages = arrayOf<UnifiedMessage>(state.agentMessages);
    conversation.title = conversationTitle(conversation.chatHistory);
    return { version: 3, activeConversationId: conversation.id, conversations: [conversation] };
  },
};

/** The saved conversations in the current format, or null if it isn't a saved chat. */
export function migrateChatState(value: unknown): Pick<ChatState, "activeConversationId" | "conversations"> | null {
  if (!isRecord(value)) return null;
  let state = value;
  let version = typeof state.version === "number" ? state.version : 1;
  while (version < CHAT_STATE_VERSION) {
    const migrate = CHAT_STATE_MIGRATIONS[version];
    if (!migrate) return null;
    state = migrate(state);
    version++;
  }
  const conversations = arrayOf<unknown>(state.conversations)
    .filter((item): item is StateRecord => isRecord(item) && typeof item.id === "string")
    .map((item): ConversationRecord => {
      const chatHistory = withoutLargeVisibleToolText(arrayOf<ChatHistoryEntry>(item.chatHistory).map(compactSelection));
      const customTitle = item.customTitle === true && typeof item.title === "string";
      const derived = conversationTitle(chatHistory);
      const automaticTitle = typeof item.automaticTitle === "string" && item.automaticTitle.trim() ? item.automaticTitle
        : !customTitle && typeof item.title === "string" && item.title.trim() ? item.title : derived;
      const first = chatHistory.find(entry => entry.type === "user");
      const titleSourceTurnId = typeof item.titleSourceTurnId === "string" ? item.titleSourceTurnId
        : item.titleSourceTurnId === null || automaticTitle !== derived ? null : first?.turnId;
      const notes = arrayOf<unknown>(item.notes).filter((note): note is string => typeof note === "string");
      const pendingMessages = arrayOf<unknown>(item.pendingMessages).filter((text): text is string => typeof text === "string");
      return {
        id: item.id as string,
        title: customTitle ? item.title as string : automaticTitle,
        automaticTitle,
        ...(titleSourceTurnId !== undefined ? { titleSourceTurnId } : {}),
        customTitle,
        createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
        updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0,
        chatHistory,
        agentMessages: withoutLargeToolText(withoutOldToolImages(trimHistory(arrayOf<UnifiedMessage>(item.agentMessages), MAX_CONVERSATION_LENGTH))),
        ...(notes.length ? { notes } : {}),
        ...(pendingMessages.length ? { pendingMessages } : {}),
      };
    });
  if (conversations.length === 0) conversations.push(newConversation());
  const active = conversations.find((conversation) => conversation.id === state.activeConversationId)
    ?? newestFirst(conversations)[0];
  return { activeConversationId: active.id, conversations };
}

/** A new, empty conversation. */
export function newConversation(now = Date.now()): ConversationRecord {
  return {
    id: `chat-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    title: NEW_CHAT_TITLE,
    customTitle: false,
    createdAt: now,
    updatedAt: now,
    chatHistory: [],
    agentMessages: [],
  };
}

/**
 * The title taken from the first user message: one line, at most 40
 * characters (an image's or file's name when there is no text).
 */
export function conversationTitle(entries: ChatHistoryEntry[]): string {
  const first = entries.find((entry) => entry.type === "user");
  const text = (first?.text ?? "").replace(/\s+/g, " ").trim() || first?.images?.[0]?.fileName || first?.attachedFiles?.[0]?.fileName || "";
  if (!text) return NEW_CHAT_TITLE;
  return text.length > TITLE_LENGTH ? `${text.slice(0, TITLE_LENGTH - 1).trimEnd()}…` : text;
}

/** Refresh only while the original first turn is present (or after an explicit reset). */
export function updateConversationTitle(conversation: ConversationRecord): void {
  const first = conversation.chatHistory.find(entry => entry.type === "user");
  if (!first) {
    conversation.automaticTitle = NEW_CHAT_TITLE;
    delete conversation.titleSourceTurnId;
  } else if (conversation.titleSourceTurnId === undefined || first.turnId === conversation.titleSourceTurnId) {
    conversation.automaticTitle = conversationTitle(conversation.chatHistory);
    conversation.titleSourceTurnId = first.turnId ?? null;
  }
  if (!conversation.customTitle) conversation.title = conversation.automaticTitle ?? conversationTitle(conversation.chatHistory);
}

/** Nothing said yet. */
export function isEmptyConversation(conversation: ConversationRecord): boolean {
  return conversation.chatHistory.length === 0 && conversation.agentMessages.length === 0;
}

/** Most recently used first. */
export function newestFirst(conversations: ConversationRecord[]): ConversationRecord[] {
  return [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
}

/** A conversation as saved: capped, image and file data only in the API history. */
export function savedConversation(conversation: ConversationRecord): ConversationRecord {
  const titled = { ...conversation };
  updateConversationTitle(titled);
  return {
    ...titled,
    chatHistory: withoutImageData(conversation.chatHistory.slice(-SAVED_ENTRIES)),
    agentMessages: withoutLargeToolText(withoutOldToolImages(trimHistory(conversation.agentMessages, MAX_CONVERSATION_LENGTH))),
  };
}

/**
 * Entries as saved: images keep their ID, name, type and size, not their
 * data; attached files likewise (their data and text stay in the API
 * history).
 */
export function withoutImageData(entries: ChatHistoryEntry[]): ChatHistoryEntry[] {
  return withoutLargeVisibleToolText(entries.map((entry) => {
    const compact = compactSelection(entry);
    if (!entry.images?.length && !entry.attachedFiles?.length) return compact;
    const saved = { ...compact };
    if (entry.images?.length) saved.images = entry.images.map(({ data: _data, ...image }) => image as ImageAttachment);
    if (entry.attachedFiles?.length) {
      saved.attachedFiles = entry.attachedFiles.map(({ id, fileName, mediaType, sizeBytes }) => ({ id, fileName, mediaType, sizeBytes, data: "" }));
    }
    return saved;
  }));
}

/**
 * Entries with their images and files taken from the API history (same
 * ID). An image the API history no longer holds (trimmed) keeps the data
 * it still has (a chat migrated from version 1, this session only) or gets
 * empty data; the view then shows a chip with its name instead. A file no
 * longer held stays a name only and isn't sent again.
 */
export function restoreImages(entries: ChatHistoryEntry[], messages: UnifiedMessage[]): ChatHistoryEntry[] {
  const images = new Map<string, ImageAttachment>();
  const files = new Map<string, FileAttachment>();
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type === "image" && block.image) images.set(block.image.id, block.image);
      if (block.type === "file" && block.file) files.set(block.file.id, block.file);
    }
  }
  return entries.map((entry) => {
    if (!entry.images?.length && !entry.attachedFiles?.length) return entry;
    const restored = { ...entry };
    if (entry.images?.length) restored.images = entry.images.map((image) => images.get(image.id) ?? (image.data ? image : { ...image, data: "" }));
    if (entry.attachedFiles?.length) restored.attachedFiles = entry.attachedFiles.map((file) => files.get(file.id) ?? file);
    return restored;
  });
}

function arrayOf<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function isRecord(value: unknown): value is StateRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactSelection(entry: ChatHistoryEntry): ChatHistoryEntry {
  const compact = entry.selection ? { ...entry, selection: historySelection(entry.selection) } : entry;
  const result = compact.toolResult?.result;
  if (typeof result !== "string") return compact;
  const clipped = boundedToolText(result);
  return clipped === result ? compact : { ...compact, toolResult: { ...compact.toolResult!, result: clipped } };
}
