// ─── Settings ───────────────────────────────────────────────────────────────

export type Provider = "anthropic" | "openai" | "chatgpt-oauth";

export interface ChatSettings {
  provider: Provider;
  /** API key for `anthropic` and `openai`. Empty for `chatgpt-oauth` (which uses SecretStorage credentials). */
  apiKey: string;
  model: string;
  maxIterations: number;
  enableWebSearch: boolean;
  modelCatalog?: import("./api/model-catalog").CatalogState;
}

export const DEFAULT_PROVIDER_MODELS: Record<Provider, string> = {
  anthropic: "claude-sonnet-4-6",
  openai: "gpt-6.1-sol",
  "chatgpt-oauth": "gpt-5.5",
};

export const DEFAULT_SETTINGS: ChatSettings = {
  provider: "anthropic",
  apiKey: "",
  model: "claude-sonnet-4-6",
  maxIterations: 20,
  enableWebSearch: true,
};

/**
 * Default model for the ChatGPT OAuth provider.
 *
 * Confirmed working in user reports. Other Codex model IDs may be unavailable
 * to a particular ChatGPT account even when listed in the CLI catalog.
 */
export const CHATGPT_OAUTH_DEFAULT_MODEL = "gpt-5.5";

// ─── Unified Message Format ─────────────────────────────────────────────────

export interface ImageAttachment {
  id: string;
  fileName: string;
  mediaType: string;
  /** Base64 image bytes without the data-URL prefix. */
  data: string;
  sizeBytes: number;
}

export interface ContentBlock {
  type: "text" | "image" | "tool_use" | "tool_result";
  text?: string;
  image?: ImageAttachment;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  is_error?: boolean;
}

export interface UnifiedMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
  /** Exact provider output for replay, separate from user-visible content. */
  replay?: ProviderReplay;
}

export interface ProviderReplay {
  provider: Provider;
  model?: string;
  identity?: string;
  items: Record<string, unknown>[];
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
}

// ─── Conversation Context ───────────────────────────────────────────────────

export interface ConversationContext {
  activeFile: string | null;
  activeFileContent: string | null;
  selection: string | null;
  vaultName: string;
  fileCount: number;
}

// ─── Selection Scope ────────────────────────────────────────────────────────

export interface SelectionScope {
  /** The selected text */
  text: string;
  /** Path to the file containing the selection */
  filePath: string;
}

// ─── Tool Execution ─────────────────────────────────────────────────────────

export interface ToolResult {
  result: string;
  isError: boolean;
}

// ─── Agent Loop Callbacks ───────────────────────────────────────────────────

export interface AgentCallbacks {
  onThinking: () => void;
  onToolCall: (name: string, input: Record<string, unknown>) => void;
  onToolResult: (name: string, result: ToolResult) => void;
  onResponse: (text: string) => void;
  onAskUser: (question: string) => Promise<string>;
  onError: (error: string) => void;
}
