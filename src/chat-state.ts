/**
 * The saved chats: `chat-state.json`, the index, and one file per chat in
 * `chats/` (from version 4); the conversation records, their format, the
 * one-time migrations from older formats, and saving each attached image
 * and file once. Pure functions; `main.ts` reads and writes the files.
 */
import { historySelection } from "./selection-history";
import type { ChatHistoryEntry, FileAttachment, ImageAttachment, UnifiedMessage } from "./types";
import { assignLegacyTurnIds, fromLastCompaction, withoutOldToolImages, withoutLargeToolText, withoutLargeVisibleToolText, boundedToolText } from "./agent/history";
import type { ConversationUsage } from "./agent/usage";

/** Current format version of `chat-state.json` and the chat files. */
export const CHAT_STATE_VERSION = 4;


/** A chat whose file is larger is marked with its size in the chat list. */
export const LARGE_CHAT_BYTES = 5 * 1024 * 1024;

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
  /**
   * Set while a turn runs (saved with it when the app goes to the
   * background); still there at the next start, the turn was cut off.
   */
  pendingTurn?: PendingTurn;
  /** Context of the last request, tokens used and estimated cost (the ring in the chat header). */
  usage?: ConversationUsage;
  /** Revision of title metadata in the index; carried unchanged for unread chats. */
  metadataSavedAt?: number;
  /** Revision of the small index checkpoint, independent of chat-file contents. */
  pendingSavedAt?: number;
  /** Size of its saved file in bytes (in the index). */
  size?: number;
  /**
   * In memory only: just its index entry was read; its histories are empty
   * until its file is read (`ChatPlugin.loadConversation`).
   */
  unloaded?: boolean;
}

/** A conversation in the index (`chat-state.json`, version 4). */
export type ConversationEntry = Pick<ConversationRecord, "id" | "title" | "automaticTitle" | "titleSourceTurnId" | "customTitle" | "createdAt" | "updatedAt" | "size" | "metadataSavedAt" | "pendingTurn" | "pendingSavedAt">;

/** A conversation as saved in its file: without the index-only fields. */
export type SavedConversation = Omit<ConversationRecord, "size" | "unloaded" | "metadataSavedAt" | "pendingSavedAt">;

/** The turn a conversation was running. */
export interface PendingTurn {
  /** A lost response could have already run external tools; never offer replay. */
  remoteEffectsPossible?: boolean;
  turnId: string;
  startedAt: number;
}

/** `chat-state.json` as this version writes it: the index. */
export interface ChatIndex {
  version: number;
  /** When it was written (ms); tells the newer of the two copies. */
  savedAt: number;
  /** The conversation the chat shows; opened again on the next start. */
  activeConversationId: string;
  conversations: ConversationEntry[];
}

/**
 * The saved chats as read: from version 4 the index, its conversations
 * `unloaded`; from older versions (migrated to version 3) every
 * conversation whole.
 */
export interface ChatState {
  version: number;
  activeConversationId: string;
  conversations: ConversationRecord[];
}

/** A chat file (`chats/<id>.json`) as read. */
export interface ChatFile {
  /** A newer-format copy must win recovery without being parsed or overwritten. */
  unsupported?: boolean;
  /** When it was written (ms); tells the newer of the two copies. */
  savedAt?: number;
  /** Written over a deleted chat's file that couldn't be removed. */
  deleted?: boolean;
  conversation?: ConversationRecord;
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

/**
 * The saved chats in the current format, or null if they aren't any. Up to
 * version 3 `chat-state.json` holds every conversation whole (migrated to
 * version 3 here; `main.ts` then writes each to its own file once); from
 * version 4 it is the index, and its conversations come back `unloaded`.
 */
export function migrateChatState(value: unknown): ChatState | null {
  if (!isRecord(value)) return null;
  let state = value;
  let version = typeof state.version === "number" ? state.version : 1;
  while (version < 3) {
    const migrate = CHAT_STATE_MIGRATIONS[version];
    if (!migrate) return null;
    state = migrate(state);
    version++;
  }
  const items = arrayOf<unknown>(state.conversations)
    .filter((item): item is StateRecord => isRecord(item) && typeof item.id === "string");
  const conversations = version >= 4 ? items.map(item => indexedConversation({ ...item, metadataSavedAt: item.metadataSavedAt ?? state.savedAt ?? 0 })) : items.map(savedRecord);

  if (conversations.length === 0) conversations.push(newConversation());
  const active = conversations.find((conversation) => conversation.id === state.activeConversationId)
    ?? newestFirst(conversations)[0];
  return { version, activeConversationId: active.id, conversations };
}

/** A conversation from its index entry: `unloaded` until its file is read. */
function indexedConversation(item: StateRecord): ConversationRecord {
  const size = item.size;
  return {
    id: item.id as string,
    title: typeof item.title === "string" && item.title ? item.title : NEW_CHAT_TITLE,
    ...(typeof item.automaticTitle === "string" && item.automaticTitle ? { automaticTitle: item.automaticTitle } : {}),
    ...(typeof item.titleSourceTurnId === "string" || item.titleSourceTurnId === null ? { titleSourceTurnId: item.titleSourceTurnId } : {}),
    customTitle: item.customTitle === true,
    createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
    updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0,
    chatHistory: [],
    agentMessages: [],
    ...(typeof size === "number" && Number.isFinite(size) && size >= 0 ? { size } : {}),
    ...(typeof item.metadataSavedAt === "number" ? { metadataSavedAt: item.metadataSavedAt } : {}),
    ...(typeof item.pendingSavedAt === "number" ? { pendingSavedAt: item.pendingSavedAt } : {}),
    ...pendingMarker(item.pendingTurn),
    unloaded: true,
  };
}

/** A whole saved conversation (in `chat-state.json` up to version 3, then in its file). */
function savedRecord(item: StateRecord): ConversationRecord {
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
  // Optional, so no new format version: an older plugin just drops it.
  return {
    id: item.id as string,
    title: customTitle ? item.title as string : automaticTitle,
    automaticTitle,
    ...(titleSourceTurnId !== undefined ? { titleSourceTurnId } : {}),
    customTitle,
    createdAt: typeof item.createdAt === "number" ? item.createdAt : 0,
    updatedAt: typeof item.updatedAt === "number" ? item.updatedAt : 0,
    chatHistory,
    // Bounded on load as when saved: old tool images and oversized tool text go.
    agentMessages: withoutLargeToolText(withoutOldToolImages(arrayOf<UnifiedMessage>(item.agentMessages))),
    ...(notes.length ? { notes } : {}),
    ...(pendingMessages.length ? { pendingMessages } : {}),
    ...pendingMarker(item.pendingTurn),
    // Optional too: an older plugin drops it.
    ...savedUsage(item.usage),
  };
}

function pendingMarker(pending: unknown): { pendingTurn?: PendingTurn } {
  return isRecord(pending) && typeof pending.turnId === "string" && typeof pending.startedAt === "number"
    ? { pendingTurn: { turnId: pending.turnId, startedAt: pending.startedAt, ...(pending.remoteEffectsPossible === true ? { remoteEffectsPossible: true } : {}) } }
    : {};
}

/**
 * A chat file's content, or null if it isn't one (or is from a newer
 * version). `main.ts` checks the histories' entries before (`isChatFile`).
 */
export function parseChatFile(value: unknown): ChatFile | null {
  if (!isRecord(value) || typeof value.version !== "number" || value.version > CHAT_STATE_VERSION) return null;
  const savedAt = typeof value.savedAt === "number" ? value.savedAt : undefined;
  if (value.deleted === true) return { ...(savedAt !== undefined ? { savedAt } : {}), deleted: true };
  const item = value.conversation;
  if (!isRecord(item) || typeof item.id !== "string") return null;
  return { ...(savedAt !== undefined ? { savedAt } : {}), conversation: savedRecord(item) };
}

/** A chat file's text; `conversation` is `savedConversation()` as JSON. */
export function chatFileText(conversation: string, savedAt: number): string {
  return `{"version":${CHAT_STATE_VERSION},"savedAt":${savedAt},"conversation":${conversation}}`;
}

/** Written over a deleted chat's file that couldn't be removed. */
export const DELETED_CHAT_FILE = `{"version":${CHAT_STATE_VERSION},"deleted":true}`;

/** A conversation's index entry. */
export function indexEntry({ id, title, automaticTitle, titleSourceTurnId, customTitle, createdAt, updatedAt, size, metadataSavedAt, pendingTurn, pendingSavedAt }: ConversationRecord): ConversationEntry {
  return {
    id, title, ...(automaticTitle !== undefined ? { automaticTitle } : {}), ...(titleSourceTurnId !== undefined ? { titleSourceTurnId } : {}),
    customTitle, createdAt, updatedAt, ...(size !== undefined ? { size } : {}), ...(metadataSavedAt !== undefined ? { metadataSavedAt } : {}),
    ...(pendingTurn ? { pendingTurn: { ...pendingTurn } } : {}), ...(pendingSavedAt !== undefined ? { pendingSavedAt } : {}),
  };
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

/** Nothing said yet (a conversation not read yet was saved with content). */
export function isEmptyConversation(conversation: ConversationRecord): boolean {
  return !conversation.unloaded && !conversation.pendingTurn?.remoteEffectsPossible && conversation.chatHistory.length === 0 && conversation.agentMessages.length === 0;
}

/** Most recently used first. */
export function newestFirst(conversations: ConversationRecord[]): ConversationRecord[] {
  return [...conversations].sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * A conversation as saved in its file: the whole visible history, the API
 * history from its last compaction on, image and file data only in the API
 * history.
 */
export function savedConversation({ size: _size, unloaded: _unloaded, metadataSavedAt: _metadataSavedAt, pendingSavedAt: _pendingSavedAt, ...conversation }: ConversationRecord): SavedConversation {
  const titled: ConversationRecord = { ...conversation };
  updateConversationTitle(titled);
  return {
    // Stable top-level order also makes cache digests independent of whether
    // the record came from an index entry or a whole chat file.
    id: titled.id, title: titled.title,
    ...(titled.automaticTitle !== undefined ? { automaticTitle: titled.automaticTitle } : {}),
    ...(titled.titleSourceTurnId !== undefined ? { titleSourceTurnId: titled.titleSourceTurnId } : {}),
    customTitle: titled.customTitle, createdAt: titled.createdAt, updatedAt: titled.updatedAt,
    chatHistory: withoutImageData(conversation.chatHistory),
    agentMessages: withoutLargeToolText(withoutOldToolImages(fromLastCompaction(conversation.agentMessages))),
    ...(titled.notes ? { notes: titled.notes } : {}),
    ...(titled.pendingMessages ? { pendingMessages: titled.pendingMessages } : {}),
    ...(titled.pendingTurn ? { pendingTurn: titled.pendingTurn } : {}),
    ...(titled.usage ? { usage: titled.usage } : {}),
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

/** A saved usage record, checked field by field (`{ usage }`), or nothing. */
function savedUsage(value: unknown): { usage?: ConversationUsage } {
  if (!isRecord(value)) return {};
  const number = (field: unknown) => (typeof field === "number" && Number.isFinite(field) && field >= 0 ? field : undefined);
  const contextTokens = number(value.contextTokens);
  const costUsd = number(value.costUsd);
  if (contextTokens === undefined || costUsd === undefined || typeof value.model !== "string" || typeof value.provider !== "string") return {};
  const lastTurnCostUsd = number(value.lastTurnCostUsd);
  return {
    usage: {
      contextTokens, costUsd, model: value.model, provider: value.provider,
      inputTokens: number(value.inputTokens) ?? 0,
      outputTokens: number(value.outputTokens) ?? 0,
      unpricedRequests: number(value.unpricedRequests) ?? 0,
      ...(lastTurnCostUsd !== undefined ? { lastTurnCostUsd } : {}),
    },
  };
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
