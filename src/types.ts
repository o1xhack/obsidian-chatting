import type { ChangeLog } from "./tools/undo";

// ─── Settings ───────────────────────────────────────────────────────────────

export type Provider = "anthropic" | "openai" | "chatgpt-oauth";

export interface ChatSettings {
  provider: Provider;
  /** API key for `anthropic` and `openai`. Empty for `chatgpt-oauth` (which uses SecretStorage credentials). */
  apiKey: string;
  model: string;
  /**
   * Thinking level as the provider names it (e.g. `"high"`). Empty: the
   * model's default. The levels on offer come from the model catalog.
   */
  thinkingLevel: string;
  maxIterations: number;
  enableWebSearch: boolean;
  /** Enter sends (Shift+Enter: new line); off: Enter is a new line, Ctrl/Cmd+Enter sends. */
  enterSends: boolean;
  /** Show each edit the AI makes: its note or canvas opens at the changed spot (`ui/show-in-view.ts`). */
  followEdits: boolean;
  /** Write `debug.log` in the plugin folder (troubleshooting; logs messages, never keys). */
  debugLog: boolean;
  /** The vault folder with the skills, a subfolder with a SKILL.md each (`agent/skills.ts`). */
  skillsFolder: string;
  /** Remote MCP servers the provider connects to (`api/mcp.ts`); tokens only in SecretStorage. */
  mcpServers: McpServer[];
  modelCatalog?: import("./api/model-catalog").CatalogState;
}

/** A remote MCP server, connected by the provider (`api/mcp.ts`). */
export interface McpServer {
  id: string;
  /** How the provider and the chat name it (letters, digits, `-`, `_`). */
  name: string;
  /** Its public https address. */
  url: string;
  enabled: boolean;
  /** Its access token, in memory only (SecretStorage `chatting-with-ai-mcp-<id>`; never in data.json). */
  token?: string;
}

/** A tool call the provider made on an MCP server, shown in the chat. */
export interface ServerToolCall {
  server: string;
  tool: string;
  input: Record<string, unknown>;
  result: string;
  isError: boolean;
  /** The provider has not supplied a result yet (for example a paused turn). */
  pending?: boolean;
}

/**
 * Each provider's default model: for a new setup, after switching providers,
 * and when no model is saved (`loadSettings()` always sets one, so the
 * adapters need no default of their own).
 *
 * ChatGPT's is confirmed working in user reports. Other Codex model IDs may
 * be unavailable to a particular ChatGPT account even when listed in the
 * CLI catalog.
 */
export const DEFAULT_PROVIDER_MODELS: Record<Provider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-6.1-sol",
  "chatgpt-oauth": "gpt-5.5",
};

export const DEFAULT_SETTINGS: ChatSettings = {
  provider: "anthropic",
  apiKey: "",
  model: DEFAULT_PROVIDER_MODELS.anthropic,
  thinkingLevel: "",
  maxIterations: 20,
  enableWebSearch: true,
  enterSends: true,
  followEdits: true,
  debugLog: false,
  skillsFolder: "Skills",
  mcpServers: [],
};

// ─── Unified Message Format ─────────────────────────────────────────────────

export interface ImageAttachment {
  id: string;
  fileName: string;
  mediaType: string;
  /** Base64 image bytes without the data-URL prefix. */
  data: string;
  sizeBytes: number;
}

/**
 * A file for the model (`files/attachments.ts`): a PDF or Office document
 * as base64 `data` (with `text` read from Word, Excel and PowerPoint files,
 * for providers that don't read them), or a text file as `text` only.
 */
export interface FileAttachment {
  id: string;
  fileName: string;
  /** The document's type; `text/plain` for a file sent as its text. */
  mediaType: string;
  /** Base64 bytes without a data-URL prefix; empty for text files and in the saved visible history. */
  data: string;
  sizeBytes: number;
  text?: string;
}

export interface ContentBlock {
  /** Internal tool-result provenance, set only by the folder instruction loader. Never sent to providers. */
  instructionSources?: string[];
  /** Internal start of the trusted instruction suffix in tool-result content. */
  instructionOffset?: number;
  type: "text" | "image" | "file" | "tool_use" | "tool_result";
  text?: string;
  image?: ImageAttachment;
  file?: FileAttachment;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
  /** tool_result only: images the tool returned (view_image, view_canvas). */
  images?: ImageAttachment[];
  /** tool_result only: files the tool returned (read_file on a PDF or Office file). */
  files?: FileAttachment[];
}

export interface UnifiedMessage {
  /** Internal provenance for folder instructions prepended to this user turn. */
  instructionSources?: string[];
  role: "user" | "assistant";
  content: string | ContentBlock[];
  /** Exact provider output for replay, separate from user-visible content. */
  replay?: ProviderReplay;
  /**
   * On the message that starts a user turn: the turn's ID, also on its
   * entry in the chat view's history, so both can be cut there.
   */
  turnId?: string;
}

export interface ProviderReplay {
  provider: Provider;
  model?: string;
  identity?: string;
  items: Record<string, unknown>[];
  /** Hashed server identities; no credentials, used to reject stale MCP replay. */
  mcpServers?: Record<string, string>;
}

// ─── Tool Definitions ───────────────────────────────────────────────────────

export interface UnifiedToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

// ─── API Response ───────────────────────────────────────────────────────────

export interface UnifiedResponse {
  content: ContentBlock[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "stop" | "pause_turn";
  replay?: ProviderReplay;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  /** Tools the provider called on MCP servers in this request; shown, not run here. */
  serverCalls?: ServerToolCall[];
}

/** Per request: where streamed answer text goes, and how Stop cancels it. */
export interface StreamOptions {
  onRequestStarted?: (remoteEffectsPossible: boolean) => void | Promise<void>;
  onTextDelta?: (text: string) => void;
  /** The provider started a tool with possible effects (an MCP call): the request must not be sent again. */
  onServerTool?: () => void;
  signal?: AbortSignal;
}

// ─── Conversation Context ───────────────────────────────────────────────────

export interface ConversationContext {
  activeFile: string | null;
  selection: string | null;
  vaultName: string;
  fileCount: number;
  /** What the user did since the last turn that the model should know (e.g. undid an answer's changes). */
  notes?: string[];
}

/** The files a message links to, for the model (`ui/mentions.ts`): their text, images as images, PDF and Office files as files. */
export interface MentionContext {
  text: string;
  images: ImageAttachment[];
  files: FileAttachment[];
  /** Vault files whose contents were loaded into this user context. */
  instructionPaths?: string[];
}

// ─── Selection Scope ────────────────────────────────────────────────────────

export interface SelectionScope {
  /** The selected text */
  text: string;
  /** Path to the file containing the selection */
  filePath: string;
  /** Where the selection starts in the note (character offset), so a repeated text isn't mistaken for it. */
  from?: number;
  /** How many copies of the text come before the selection in the note (0: it is the first). */
  occurrence?: number;
  /** In-memory editor snapshot used to relocate safely; never sent to the model. */
  sourceText?: string;
  /** Persisted fingerprint; replay refuses edits if the note has changed. */
  sourceHash?: string;
}

// ─── Chat View History ──────────────────────────────────────────────────────

/** One entry of the visible chat history (`plugin.chatHistory`). */
export interface ChatHistoryEntry {
  type: "user" | "assistant" | "tool-result" | "error" | "changes";
  text?: string;
  /** Original active note for resolving links again on edit/regenerate. Empty means vault root. */
  linkSource?: string;
  images?: ImageAttachment[];
  /** User entries: attached files (saved without data and text; restored from the API history). */
  attachedFiles?: FileAttachment[];
  /**
   * User entries of a turn (not `ask_user` answers): the turn's ID, shared
   * with the agent history; changes entries: the turn that made them.
   */
  turnId?: string;
  /** User entries: the selection scope the turn ran with. */
  selection?: SelectionScope;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: { result: string; isError: boolean };
  /** Error entries: "stopped" is the quiet note left by Stop before any answer was shown. */
  errorKind?: "stopped";
  /** Changes entries (at the end of a turn): the files the turn changed. */
  files?: string[];
  /** Changes entries: the user undid them. */
  undone?: boolean;
}

/** A row of the chat view's history list. */
export interface ConversationSummary {
  id: string;
  title: string;
  /** Last use, in ms. */
  updatedAt: number;
  /** The conversation shown now. */
  active: boolean;
  /** A turn runs in it (also in the background). */
  running?: boolean;
}

// ─── Tool Execution ─────────────────────────────────────────────────────────

export interface ToolResult {
  result: string;
  isError: boolean;
  /** Internal first-touch paths (e.g. search reads); consumed by the loop, not saved or sent as metadata. */
  instructionPaths?: string[];
  /**
   * Images for the model. They are kept only in the agent history; the
   * chat view gets the text with a marker instead (`AgentLoop`).
   */
  images?: ImageAttachment[];
  /** Files for the model (read_file on a PDF or Office file); like images, only in the agent history. */
  files?: FileAttachment[];
  /** What a tool changed, for showing it to the user; never sent to the model or saved. */
  focus?: ViewTarget;
}

/** A spot to show in a note (character range) or canvas (card IDs). */
export interface ViewTarget {
  path: string;
  /** Range in the note's text after the change. */
  from?: number;
  to?: number;
  /** Canvas cards. */
  nodes?: string[];
}

// ─── Agent Loop Callbacks ───────────────────────────────────────────────────

export interface AgentCallbacks {
  /** Persist uncertainty before a request capable of external side effects. */
  onRequestStarted?: (remoteEffectsPossible: boolean) => void | Promise<void>;
  onThinking: () => void;
  /** Answer text as it streams in; `onResponse` later gives the whole text. */
  onTextDelta?: (text: string) => void;
  onToolCall: (name: string, input: Record<string, unknown>) => void;
  onToolResult: (name: string, result: ToolResult) => void;
  onResponse: (text: string) => void;
  onAskUser: (question: string) => Promise<string>;
  onError: (error: string) => void;
  /** A first request rejected locally before transport; the UI can restore its unsent draft. */
  onPreflightRejected?: (error: string) => void;
  /** A message the user added to the running turn (`AgentLoop.steer`) went out with its next step. */
  onSteered?: (text: string) => void;
  /**
   * A request that failed or stalled in the background is sent again now
   * that Obsidian is back; text streamed by the failed attempt is to be
   * dropped.
   */
  onResuming?: () => void;
  /** Where the turn's tools record their vault changes (undo per answer). */
  changes?: ChangeLog;
}
