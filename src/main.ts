import {
  Plugin,
  Notice,
  type MarkdownFileInfo,
  type Editor,
  Menu,
  TFile,
  type TAbstractFile,
  type App,
} from "obsidian";
import type { ChatSettings, SelectionScope, ChatHistoryEntry, ConversationSummary } from "./types";
import { DEFAULT_SETTINGS, DEFAULT_PROVIDER_MODELS } from "./types";
import { copiesBefore } from "./tools/executor";
import { ChatSettingTab, getModelHeaderLabel } from "./settings";
import { ObsidianChatView, VIEW_TYPE_CHAT } from "./ui/chat-view";
import { closeFollowTab, closeLeftoverFollowTab } from "./ui/show-in-view";
import { AgentLoop } from "./agent/loop";
import type { ChangeLog } from "./tools/undo";
import { boundConversationAttachments } from "./attachment-history";
import {
  CHAT_STATE_VERSION,
  conversationTitle,
  updateConversationTitle,
  isEmptyConversation,
  migrateChatState,
  newConversation,
  newestFirst,
  restoreImages,
  savedConversation,
  type ChatState,
  type ConversationRecord,
} from "./chat-state";
import { ChatGPTOAuthStore } from "./auth/chatgptOAuthStore";
import { ChatGPTOAuthService } from "./auth/chatgptOAuth";
import { migrateOAuthModel as migrateChatGPTOAuthModelSlug, cachedCatalog, catalogIdentity, normalizeCatalogState } from "./api/model-catalog";
import { setChatGPTOAuthService } from "./api/chatgpt-oauth";
import { readDebugLog, setDebugLogging } from "./debug";
import { screenAwake } from "./platform/screen-awake";

const PLUGIN_ID = "chatting-with-ai";
const LEGACY_PLUGIN_ID = "obsidian-chatting";
const LEGACY_RELEASE_ASSETS = new Set(["main.js", "manifest.json", "styles.css"]);
const SECRET_PROVIDERS = ["anthropic", "openai", "chatgpt-oauth"];
const CHATGPT_OAUTH_SECRET_KEY = `${PLUGIN_ID}-chatgpt-oauth`;
const LEGACY_CHATGPT_OAUTH_SECRET_KEY = `${LEGACY_PLUGIN_ID}-chatgpt-oauth`;
// App survives plugin bundle reloads; Symbol.for gives each new bundle
// the same key without persisting promises or adding a file lock.
const CHAT_STATE_WRITE = Symbol.for("chatting-with-ai-pending-chat-state-write");
type ChatPersistenceApp = App & { [CHAT_STATE_WRITE]?: Promise<void> };

/** The editor's selection as a scope, with where it starts in the note. */
export function selectionScope(editor: Editor, text: string, filePath: string): SelectionScope {
  const from = editor.posToOffset(editor.getCursor("from"));
  const sourceText = editor.getValue().replace(/\r\n/g, "\n");
  return { text, filePath, from, occurrence: copiesBefore(sourceText, text, from), sourceText };
}

export default class ChatPlugin extends Plugin {
  settings: ChatSettings = DEFAULT_SETTINGS;
  /** Shared agent loop that persists across view open/close cycles */
  agent!: AgentLoop;
  /** ChatGPT OAuth service (used by the chatgpt-oauth provider). */
  chatgptOAuth!: ChatGPTOAuthService;
  /**
   * All conversations. The active one's API history lives in `agent` and
   * is copied into its record when saving or switching.
   */
  conversations: ConversationRecord[] = [newConversation()];
  activeConversationId = this.conversations[0].id;
  /**
   * The vault changes of each answer, for undo, by the answer's changes
   * entry in its conversation's history. In memory only (until Obsidian
   * closes); dropped with the entry (clear, edit, delete).
   */
  readonly changeLogs = new WeakMap<ChatHistoryEntry, ChangeLog>();
  /** Set once the saved chat has been read; saves before that would overwrite it. */
  private chatHistoryLoaded = false;
  /** The chat-state write in progress, and the one queued after it. */
  private chatStateWrite: Promise<void> | null = null;
  private nextChatStateWrite: Promise<void> | null = null;
  /** Monotonic across saves, including a clock adjustment or equal millisecond. */
  private lastChatStateSavedAt = 0;
  /** Once unloaded, only the already queued final save may finish. */
  private unloaded = false;

  /** The conversation the chat view shows. */
  get activeConversation(): ConversationRecord {
    return this.conversations.find((conversation) => conversation.id === this.activeConversationId)
      ?? this.conversations[0];
  }

  /** The active conversation's messages, for replaying into the UI when the view reopens. */
  get chatHistory(): ChatHistoryEntry[] {
    return this.activeConversation.chatHistory;
  }

  set chatHistory(entries: ChatHistoryEntry[]) {
    this.activeConversation.chatHistory = entries;
  }

  async onload(): Promise<void> {
    await this.waitForChatStateWrites();
    await this.migrateLegacyPluginData();
    await this.loadSettings();

    // Wire ChatGPT OAuth before constructing the agent: the OAuth API client
    // looks up the service via setChatGPTOAuthService().
    const oauthStore = new ChatGPTOAuthStore(this.app);
    this.chatgptOAuth = new ChatGPTOAuthService(oauthStore);
    setChatGPTOAuthService(this.chatgptOAuth);
    // The chat header shows the thinking level from the saved model list.
    await this.activateModelCatalog();

    this.agent = new AgentLoop(this.app, this.settings);

    // Restore persisted chat history
    await this.loadChatHistory();
    // A follow tab saved with the layout when Obsidian last closed goes.
    this.app.workspace.onLayoutReady(() => closeLeftoverFollowTab(this.app));

    this.addSettingTab(new ChatSettingTab(this.app, this));

    // Register sidebar view (loads deferred by default in v1.7.2+)
    this.registerView(VIEW_TYPE_CHAT, (leaf) => new ObsidianChatView(leaf, this));

    // Ribbon icon (users can hide; commands are the primary access)
    this.addRibbonIcon("message-circle", "Open Chatting with AI", (evt) => {
      if (evt.type === "contextmenu" || evt.button === 2) {
        // Right-click: show menu with options
        const menu = new Menu();
        menu.addItem((item) =>
          item.setTitle("Open chat").setIcon("message-circle").onClick(() => void this.openChat())
        );
        menu.addItem((item) =>
          item.setTitle("New chat").setIcon("square-pen").onClick(() => void this.newChat())
        );
        menu.addItem((item) =>
          item.setTitle("Chat about active note").setIcon("file-text").onClick(() => void this.chatAboutActiveNote())
        );
        menu.addItem((item) =>
          item.setTitle("Copy transcript").setIcon("clipboard").onClick(() => this.shareTranscript())
        );
        menu.showAtMouseEvent(evt);
      } else {
        void this.openChat();
      }
    });

    // ─── Commands ────────────────────────────────────────────────────────

    this.addCommand({
      id: "open-chat",
      name: "Open chat",
      callback: () => void this.openChat(),
    });

    this.addCommand({
      id: "new-chat",
      name: "New chat",
      callback: () => void this.newChat(),
    });

    this.addCommand({
      id: "copy-transcript",
      name: "Copy conversation transcript to clipboard",
      callback: () => this.shareTranscript(),
    });

    this.addCommand({
      id: "clear-chat",
      name: "Clear conversation",
      callback: () => this.clearChat(),
    });

    // Gets the debug log off a phone: paste it into a note or a message.
    this.addCommand({
      id: "copy-debug-log",
      name: "Copy debug log",
      callback: () => void this.copyDebugLog(),
    });

    // Editor command: chat about the current note (only when editor is active)
    this.addCommand({
      id: "chat-about-note",
      name: "Chat about this note",
      editorCallback: (editor: Editor, ctx: MarkdownFileInfo) => {
        void this.openChatWithMessage(`Summarize this note: ${ctx.file?.path ?? "the active document"}`);
      },
    });

    // Editor command: chat about selected text (conditional, only when text is selected)
    this.addCommand({
      id: "send-selection",
      name: "Send selection to chat",
      editorCheckCallback: (checking: boolean, editor: Editor, ctx: MarkdownFileInfo) => {
        const sel = editor.getSelection();
        if (!sel || sel.length === 0) return false;
        if (checking) return true;
        const scope = selectionScope(editor, sel, ctx.file?.path ?? "");
        void this.openChatWithSelection(scope);
        return true;
      },
    });

    // ─── Context menus ──────────────────────────────────────────────────

    // File explorer context menu
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((item) =>
          item
            .setTitle("Chat about this note")
            .setIcon("message-circle")
            .onClick(() => void this.openChatWithMessage(`Tell me about ${file.path}`))
        );
      })
    );

    // Editor right-click context menu
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, editor: Editor, info: MarkdownFileInfo) => {
        const sel = editor.getSelection();
        if (sel && sel.length > 0) {
          // Read now, while the selection the menu was opened on is current.
          const scope = selectionScope(editor, sel, info.file?.path ?? "");
          menu.addItem((item) =>
            item
              .setTitle("Send selection to chat")
              .setIcon("message-circle")
              .onClick(() => {
                void this.openChatWithSelection(scope);
              })
          );
        }
      })
    );
  }

  onunload(): void {
    this.chatgptOAuth?.cancelBrowserLogin();
    this.agent?.abort();
    screenAwake.reset();
    // The tab that showed the AI's edits closes with the plugin (and Obsidian).
    closeFollowTab(this.app);
    void this.saveChatHistory();
    this.unloaded = true;
  }

  // ─── Chat operations ────────────────────────────────────────────────

  /**
   * True if the active provider is configured enough to send a message.
   * - anthropic / openai: an API key is set.
   * - chatgpt-oauth: a credential is present in SecretStorage.
   */
  private isProviderConfigured(): boolean {
    if (this.settings.provider === "chatgpt-oauth") {
      return !!this.chatgptOAuth?.getCredential();
    }
    return !!this.settings.apiKey;
  }

  private notConfiguredMessage(): string {
    if (this.settings.provider === "chatgpt-oauth") {
      return "Connect your ChatGPT account in Chatting with AI settings.";
    }
    return "Please configure your API key in Chatting with AI settings.";
  }

  /**
   * Opens the chat view and resolves with it once its UI is mounted; null
   * when the provider isn't set up (with a notice) or no chat view opened.
   */
  private async openChat(): Promise<ObsidianChatView | null> {
    if (!this.isProviderConfigured()) {
      new Notice(this.notConfiguredMessage());
      return null;
    }
    return this.activateView();
  }

  /** Opens the chat on a new conversation. */
  private async newChat(): Promise<void> {
    const view = await this.openChat();
    view?.newChat();
  }

  /** Open a new chat and immediately send a message */
  private async openChatWithMessage(message: string): Promise<void> {
    const view = await this.openChat();
    if (!view) return;
    // A new topic: in a new conversation, like the chat apps.
    view.newChat();
    view.sendMessage(message);
  }

  /** Open a new chat with a selection scope (shows pill, user types their own question) */
  private async openChatWithSelection(selection: SelectionScope): Promise<void> {
    const view = await this.openChat();
    if (!view) return;
    view.newChat();
    view.setSelection(selection);
    view.focus();
  }

  private async chatAboutActiveNote(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!file) {
      new Notice("No active note.");
      return;
    }
    await this.openChatWithMessage(`Tell me about ${file.path}`);
  }

  /**
   * Open or reveal the chat view in the right sidebar (both desktop and
   * mobile); resolves with the view once its UI is mounted.
   */
  private async activateView(): Promise<ObsidianChatView | null> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(VIEW_TYPE_CHAT)[0];
    if (!leaf) {
      // Right sidebar on both desktop and mobile.
      // On mobile, this slides in as a panel from the right edge.
      const right = workspace.getRightLeaf(false);
      if (!right) return null;
      await right.setViewState({ type: VIEW_TYPE_CHAT, active: true });
      leaf = right;
    }
    // Also loads a deferred view (Obsidian 1.7.2+).
    await workspace.revealLeaf(leaf);
    if (!(leaf.view instanceof ObsidianChatView)) return null;
    await leaf.view.ready;
    return leaf.view;
  }

  /** Get the active ObsidianChatView using proper instanceof check (deferred view safe) */
  private getChatView(): ObsidianChatView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_CHAT);
    for (const leaf of leaves) {
      if (leaf.view instanceof ObsidianChatView) {
        return leaf.view;
      }
    }
    return null;
  }

  /** Copy the conversation's API history as Markdown (for debugging); works with the chat panel closed. */
  private shareTranscript(): void {
    if (this.agent.isEmpty()) {
      new Notice("Conversation is empty.");
      return;
    }

    navigator.clipboard.writeText(this.agent.exportTranscript()).then(() => {
      new Notice("Transcript copied to clipboard.");
    }).catch(() => {
      new Notice("Failed to copy transcript.");
    });
  }

  private clearChat(): void {
    const view = this.getChatView();
    if (view) {
      view.clearConversation();
      new Notice("Conversation cleared.");
    } else {
      new Notice("No active conversation.");
    }
  }

  // ─── Conversations ──────────────────────────────────────────────────
  // The view stops a running turn before calling these.

  /** Conversations with content, most recently used first (the history list). */
  listConversations(): ConversationSummary[] {
    this.storeActiveMessages();
    return newestFirst(this.conversations)
      .filter((conversation) => !isEmptyConversation(conversation))
      .map(({ id, title, updatedAt }) => ({ id, title, updatedAt, active: id === this.activeConversationId }));
  }

  /** Makes a new empty conversation active; an empty active one is kept instead. */
  startNewConversation(): void {
    this.storeActiveMessages();
    if (isEmptyConversation(this.activeConversation)) return;
    const conversation = newConversation();
    this.conversations.push(conversation);
    this.activate(conversation);
  }

  /** Makes conversation `id` active. */
  openConversation(id: string): void {
    const next = this.conversations.find((conversation) => conversation.id === id);
    if (!next || next.id === this.activeConversationId) return;
    this.storeActiveMessages();
    this.activate(next);
  }

  /** Renames conversation `id`; an empty name goes back to the automatic title. */
  renameConversation(id: string, title: string): void {
    const conversation = this.conversations.find((item) => item.id === id);
    if (!conversation) return;
    const name = title.replace(/\s+/g, " ").trim();
    conversation.customTitle = name !== "";
    conversation.title = name || conversation.automaticTitle || conversationTitle(conversation.chatHistory);
    void this.saveChatHistory();
  }

  /** Deletes conversation `id`; deleting the active one opens the most recent other, or a new one. */
  deleteConversation(id: string): void {
    const deleted = this.conversations.find((conversation) => conversation.id === id);
    if (!deleted) return;
    this.conversations = this.conversations.filter((conversation) => conversation !== deleted);
    if (deleted.id !== this.activeConversationId) {
      void this.saveChatHistory();
      return;
    }
    const next = newestFirst(this.conversations)[0] ?? newConversation();
    if (!this.conversations.includes(next)) this.conversations.push(next);
    this.activate(next);
  }

  /** Called when a turn starts or the conversation is cleared: order and title. */
  touchConversation(): void {
    const conversation = this.activeConversation;
    conversation.updatedAt = Date.now();
    updateConversationTitle(conversation);
  }

  /** Switches the agent to `next`; an empty conversation left behind is dropped. */
  private activate(next: ConversationRecord): void {
    // None when the active conversation was just deleted.
    const previous = this.conversations.find((conversation) => conversation.id === this.activeConversationId);
    this.agent.abort();
    this.activeConversationId = next.id;
    // Also forgets OpenAI's response to chain to: it belongs to the other conversation.
    this.agent.importMessages(next.agentMessages);
    if (previous && previous !== next && isEmptyConversation(previous)) {
      this.conversations = this.conversations.filter((conversation) => conversation !== previous);
    }
    void this.saveChatHistory();
  }

  /** Copies the agent's history into the active conversation's record. */
  private storeActiveMessages(): void {
    this.agent?.trimForRetention();
    if (this.agent) this.activeConversation.agentMessages = this.agent.exportMessages();
    const bounded = boundConversationAttachments(this.conversations, this.activeConversationId);
    if (bounded.changed.has(this.activeConversationId)) {
      this.agent.invalidateHistoryCursor();
      this.getChatView()?.refreshAttachmentData();
    }
    if (bounded.omitted) new Notice("Older attachment data was removed from chat history to stay within the shared 32 MiB budget. File names and conversation text are kept; reattach a file to use it again.");
  }

  // ─── Chat history persistence ─────────────────────────────────────────

  /**
   * Saves the chats. One write at a time: a save asked for while one is
   * being written waits for it, and all such calls share that one next
   * write, which takes the state when it starts.
   */
  saveChatHistory(): Promise<void> {
    if (!this.chatHistoryLoaded || this.unloaded) return Promise.resolve();
    if (!this.chatStateWrite) return this.startChatStateWrite();
    if (!this.nextChatStateWrite) {
      this.nextChatStateWrite = this.chatStateWrite.then(() => {
        this.nextChatStateWrite = null;
        return this.startChatStateWrite();
      });
      this.trackChatStateWrite(this.nextChatStateWrite);
    }
    return this.nextChatStateWrite;
  }

  /** Publish the latest queued save immediately, including an unload save. */
  private trackChatStateWrite(write: Promise<void>): void {
    const app = this.app as ChatPersistenceApp;
    app[CHAT_STATE_WRITE] = write;
    void write.then(() => {
      if (app[CHAT_STATE_WRITE] === write) delete app[CHAT_STATE_WRITE];
    });
  }

  /** A newly loaded plugin must see the previous instance's final snapshot. */
  private async waitForChatStateWrites(): Promise<void> {
    const app = this.app as ChatPersistenceApp;
    while (app[CHAT_STATE_WRITE]) {
      await app[CHAT_STATE_WRITE];
    }
  }

  private startChatStateWrite(): Promise<void> {
    const write: Promise<void> = this.writeChatState().finally(() => {
      if (this.chatStateWrite === write) this.chatStateWrite = null;
    });
    this.chatStateWrite = write;
    this.trackChatStateWrite(write);
    return write;
  }

  /**
   * Writes the current state; it is taken before the first await. Never
   * throws. The adapter empties a file before writing it, and Obsidian may
   * end mid-write (reload, quit: onunload saves too), so the state is
   * written twice: to `chat-state.next.json`, then to `chat-state.json`.
   * One of them is always whole; loading takes the newer whole one. No
   * delete and rename: on Windows a file another process has open stays
   * "delete pending" and the rename then fails.
   */
  private async writeChatState(): Promise<void> {
    try {
      this.storeActiveMessages();
      const state: ChatState = {
        version: CHAT_STATE_VERSION,
        // Which of the two copies is newer when both are whole.
        savedAt: this.lastChatStateSavedAt = Math.max(Date.now(), this.lastChatStateSavedAt + 1),
        activeConversationId: this.activeConversationId,
        // Per conversation: the last 100 UI entries and 80 API messages
        // (complete turns); image data only in the API history. An empty
        // conversation is kept only while it is the active one.
        conversations: this.conversations
          .filter((conversation) => conversation.id === this.activeConversationId || !isEmptyConversation(conversation))
          .map(savedConversation),
      };
      const json = JSON.stringify(state);
      const { adapter } = this.app.vault;
      await adapter.write(this.nextChatStatePath, json);
      await adapter.write(this.chatStatePath, json);
    } catch {
      // Persistence is best-effort
    }
  }

  private async loadChatHistory(): Promise<void> {
    await this.waitForChatStateWrites();
    const state = await this.readChatState();
    // Unreadable and not set aside: saving would overwrite it.
    if (state === undefined) return;
    if (state) this.lastChatStateSavedAt = state.savedAt ?? 0;
    // Older formats are migrated here; the next save writes the current one.
    const saved = state && migrateChatState(state);
    if (saved) {
      const bounded = boundConversationAttachments(saved.conversations, saved.activeConversationId);
      if (bounded.omitted) new Notice("Older attachment data was removed from chat history to stay within the shared 32 MiB budget. File names and conversation text are kept; reattach a file to use it again.");
      // The images' data comes from each conversation's API history (same image ID).
      for (const conversation of saved.conversations) {
        conversation.chatHistory = restoreImages(conversation.chatHistory, conversation.agentMessages);
      }
      this.conversations = saved.conversations;
      this.activeConversationId = saved.activeConversationId;
      this.agent.importMessages(this.activeConversation.agentMessages);
    }
    this.chatHistoryLoaded = true;
  }

  /**
   * The saved chat: the newer of `chat-state.json` and its copy
   * `chat-state.next.json`, else the legacy file. Null when there is none
   * yet, or when `chat-state.json` couldn't be read and was renamed to
   * `chat-state.corrupt-<time>.json` (with a notice), or was written by a
   * newer version (`keepIfNewer`); undefined when it couldn't be read and
   * couldn't be renamed or kept either.
   */
  private async readChatState(): Promise<PersistedChatState | null | undefined> {
    const { adapter } = this.app.vault;
    const read = async (file: string): Promise<PersistedChatState> => {
      const state: unknown = JSON.parse(await adapter.read(file));
      // A newer version's format isn't checked here: keepIfNewer keeps it aside.
      if (isRecord(state) && typeof state.version === "number" && state.version > CHAT_STATE_VERSION) return state;
      if (!isPersistedChatState(state)) throw new Error("Not a saved chat");
      return state;
    };
    const path = this.chatStatePath;
    let exists = true;
    let main: PersistedChatState | null = null;
    try {
      main = await read(path);
    } catch {
      exists = await adapter.exists(path).catch(() => true);
    }
    // The copy: whole when chat-state.json was cut off while written, and
    // newer when Obsidian ended between the two writes, or writing
    // chat-state.json failed (another program had it open).
    let copy: PersistedChatState | null = null;
    let copyExists = true;
    try {
      copy = await read(this.nextChatStatePath);
    } catch {
      copyExists = await adapter.exists(this.nextChatStatePath).catch(() => true);
    }
    if (main && copy) {
      // 0.4.0 can read this format but drops savedAt when saving. If its
      // main file was rewritten after our copy, use its changes rather
      // than resurrecting old messages after an upgrade back to this version.
      if (main.savedAt === undefined && copy.savedAt !== undefined) {
        try {
          const [mainStat, copyStat] = await Promise.all([adapter.stat(path), adapter.stat(this.nextChatStatePath)]);
          // Coarse mobile/filesystem timestamps can tie. In that ambiguous
          // case prefer the old-version main file over resurrecting its copy.
          if (mainStat && copyStat && mainStat.mtime >= copyStat.mtime) return this.keepIfNewer(main);
        } catch {
          // A stat failure retains normal timestamp-based recovery.
        }
      }
      return this.keepIfNewer((copy.savedAt ?? 0) > (main.savedAt ?? 0) ? copy : main);
    }
    const saved = main ?? copy;
    if (saved) return this.keepIfNewer(saved);
    // Both files are unreadable: keep every existing copy before any
    // fresh save. This also protects a lone truncated .next file.
    const unreadable = [exists ? path : null, copyExists ? this.nextChatStatePath : null]
      .filter((file): file is string => file !== null);
    for (const file of unreadable) {
      const name = `${file === path ? "chat-state" : "chat-state.next"}.corrupt-${Date.now()}.json`;
      try {
        await adapter.rename(file, `${this.pluginDataDir}/${name}`);
      } catch {
        new Notice("The saved chat couldn't be read. The file is left as it is, and the chat isn't saved until Obsidian restarts.");
        return undefined;
      }
      new Notice(`The saved chat couldn't be read. The file was kept as ${name} in the plugin folder; starting with an empty chat.`);
    }
    if (!exists) {
      try {
        return await read(this.legacyChatStatePath);
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * A chat saved by a newer version of the plugin (after a downgrade) isn't
   * read: this version would drop what it doesn't know, and its next save
   * would overwrite the file. It is kept as `chat-state.v<version>-<time>.json`
   * and the chat starts empty (null, with a notice); undefined when it
   * couldn't be kept. Any other chat is returned as it is.
   */
  private async keepIfNewer(state: PersistedChatState): Promise<PersistedChatState | null | undefined> {
    if (typeof state.version !== "number" || state.version <= CHAT_STATE_VERSION) return state;
    const name = `chat-state.v${state.version}-${Date.now()}.json`;
    try {
      await this.app.vault.adapter.write(`${this.pluginDataDir}/${name}`, JSON.stringify(state));
    } catch {
      new Notice("The saved chat is from a newer version of the plugin. The file is left as it is, and the chat isn't saved until Obsidian restarts.");
      return undefined;
    }
    new Notice(`The saved chat is from a newer version of the plugin. It was kept as ${name} in the plugin folder; starting with an empty chat.`);
    return null;
  }

  // ─── Settings persistence ────────────────────────────────────────────

  async loadSettings(): Promise<void> {
    const saved = normalizeSettings(await this.loadData());
    this.settings = { ...DEFAULT_SETTINGS, ...saved };
    // Not the default's array, which edits would change.
    this.settings.mcpServers = [...this.settings.mcpServers];

    // Fall back to default model if saved model is empty
    if (!this.settings.model) {
      this.settings.model = DEFAULT_PROVIDER_MODELS[this.settings.provider];
    }

    // Migrate ChatGPT OAuth model slugs that an earlier release wrote with
    // dash-form versions (`gpt-5-5`, `gpt-5-2`, …). The Codex backend only
    // accepts dotted slugs (`gpt-5.5`, `gpt-5.2`, …) and rejects the
    // dash form with HTTP 400. We rewrite in place and persist back.
    if (this.settings.provider === "chatgpt-oauth") {
      const migrated = migrateChatGPTOAuthModelSlug(this.settings.model);
      if (migrated !== this.settings.model) {
        this.settings.model = migrated;
        // Best-effort save; ignore errors during initial load
        this.saveData({ ...this.settings, apiKey: "" }).catch(() => {});
      }
    }

    // Load API key for the current provider from SecretStorage
    this.settings.apiKey = this.loadApiKey(this.settings.provider);
    // MCP servers' tokens, likewise
    for (const server of this.settings.mcpServers) {
      const token = this.readSecret(mcpSecretKey(server.id));
      if (token) server.token = token;
    }
    setDebugLogging(this.settings.debugLog);
  }

  async saveSettings(): Promise<void> {
    // Store API key in SecretStorage keyed by provider
    this.saveApiKey(this.settings.provider, this.settings.apiKey || "");
    const servers = this.settings.mcpServers ?? [];
    // Only tokens this device has (loaded or typed): a token that didn't load,
    // or a server synced from another device, isn't overwritten with "".
    for (const server of servers) {
      if (server.token !== undefined) this.writeSecret(mcpSecretKey(server.id), server.token);
    }

    // Save all other settings to data.json (syncs), but strip the API key and MCP tokens
    const toSave = { ...this.settings, apiKey: "", mcpServers: servers.map(({ token: _token, ...server }) => server) };
    await this.saveData(toSave);
    setDebugLogging(this.settings.debugLog);

    // Update the chat view header with the new model name and thinking level
    this.refreshModelHeader();
    const view = this.getChatView();
    view?.updateEnterSends();
    view?.updateFollowEdits();
  }

  /** Refresh catalog-derived display metadata without rewriting settings or secrets. */
  refreshModelHeader(): void {
    this.getChatView()?.updateModel(this.modelHeaderLabel());
  }

  /** Copy `debug.log` to the clipboard (the "Debug log" setting writes it). */
  async copyDebugLog(): Promise<void> {
    const log = await readDebugLog(this.app);
    if (!log) {
      new Notice(this.settings.debugLog ? "The debug log is empty." : "The debug log is empty. Turn on Debug log in settings first.");
      return;
    }
    try {
      await navigator.clipboard.writeText(log);
      new Notice(`Debug log copied (${Math.ceil(log.length / 1024)} KB).`);
    } catch {
      new Notice("Couldn't copy the debug log.");
    }
  }

  /** Model name and thinking level, as shown in the chat view header. */
  modelHeaderLabel(): string {
    const { provider, model, thinkingLevel } = this.settings;
    return getModelHeaderLabel(provider, model, thinkingLevel);
  }

  /** Activate the saved model list of the current provider and account (no network). */
  private async activateModelCatalog(): Promise<void> {
    const { provider, apiKey, modelCatalog } = this.settings;
    const credential = provider === "chatgpt-oauth" ? this.chatgptOAuth.getCredential() : null;
    const secretIdentity = provider === "chatgpt-oauth" ? credential?.accountId || credential?.accessToken : apiKey;
    if (!secretIdentity || !modelCatalog) return;
    cachedCatalog(modelCatalog, provider, await catalogIdentity(provider, secretIdentity));
  }

  /** Load the correct API key when provider changes */
  reloadApiKeyForProvider(): void {
    this.settings.apiKey = this.loadApiKey(this.settings.provider);
  }

  private loadApiKey(provider: string): string {
    try {
      return (
        this.app.secretStorage.getSecret(`${PLUGIN_ID}-api-key-${provider}`) ||
        this.app.secretStorage.getSecret(`${LEGACY_PLUGIN_ID}-api-key-${provider}`) ||
        ""
      );
    } catch {
      return "";
    }
  }

  /** Remove an MCP server and its token. */
  async removeMcpServer(id: string): Promise<void> {
    this.writeSecret(mcpSecretKey(id), "");
    this.settings.mcpServers = this.settings.mcpServers.filter((server) => server.id !== id);
    await this.saveSettings();
  }

  private readSecret(key: string): string {
    try {
      return this.app.secretStorage.getSecret(key) || "";
    } catch {
      return "";
    }
  }

  private writeSecret(key: string, value: string): void {
    try {
      this.app.secretStorage.setSecret(key, value);
    } catch {
      // SecretStorage not available
    }
  }

  private saveApiKey(provider: string, key: string): void {
    try {
      this.app.secretStorage.setSecret(`${PLUGIN_ID}-api-key-${provider}`, key);
    } catch {
      // SecretStorage not available
    }
  }

  private async migrateLegacyPluginData(): Promise<void> {
    await this.migrateLegacyDataFiles();
    this.migrateLegacySecrets();
  }

  private async migrateLegacyDataFiles(): Promise<void> {
    const adapter = this.app.vault.adapter;
    try {
      if (!(await adapter.exists(this.legacyPluginDataDir))) return;
      await this.ensureFolder(this.pluginDataDir);
      await this.copyLegacyPluginDataDir(this.legacyPluginDataDir, this.pluginDataDir, true);

      await adapter.rmdir(this.legacyPluginDataDir, true);
    } catch {
      // Migration is best-effort; legacy fallback reads still protect users.
    }
  }

  private async copyLegacyPluginDataDir(fromDir: string, toDir: string, isRoot: boolean): Promise<void> {
    const adapter = this.app.vault.adapter;
    const listed = await adapter.list(fromDir);

    for (const folder of listed.folders) {
      const name = folder.split("/").pop();
      if (!name) continue;
      const target = `${toDir}/${name}`;
      await this.ensureFolder(target);
      await this.copyLegacyPluginDataDir(folder, target, false);
    }

    for (const file of listed.files) {
      const name = file.split("/").pop();
      if (!name) continue;
      if (isRoot && LEGACY_RELEASE_ASSETS.has(name)) continue;

      const target = `${toDir}/${name}`;
      if (!(await adapter.exists(target))) {
        await adapter.writeBinary(target, await adapter.readBinary(file));
      }
    }
  }

  private async ensureFolder(path: string): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (await adapter.exists(path)) return;
    const parent = path.split("/").slice(0, -1).join("/");
    if (parent) await this.ensureFolder(parent);
    try {
      await adapter.mkdir(path);
    } catch {
      // Another plugin startup path may have created it first.
    }
  }

  private migrateLegacySecrets(): void {
    for (const provider of SECRET_PROVIDERS) {
      this.migrateSecret(
        `${PLUGIN_ID}-api-key-${provider}`,
        `${LEGACY_PLUGIN_ID}-api-key-${provider}`,
      );
    }
    this.migrateSecret(CHATGPT_OAUTH_SECRET_KEY, LEGACY_CHATGPT_OAUTH_SECRET_KEY);
  }

  private migrateSecret(currentKey: string, legacyKey: string): void {
    try {
      const currentValue = this.app.secretStorage.getSecret(currentKey);
      const legacyValue = this.app.secretStorage.getSecret(legacyKey);
      if (legacyValue && !currentValue) {
        this.app.secretStorage.setSecret(currentKey, legacyValue);
      }
      if (legacyValue) {
        this.app.secretStorage.setSecret(legacyKey, "");
      }
    } catch {
      // SecretStorage may be unavailable on very old Obsidian versions.
    }
  }

  private get pluginDataDir(): string {
    return `${this.app.vault.configDir}/plugins/${PLUGIN_ID}`;
  }

  private get legacyPluginDataDir(): string {
    return `${this.app.vault.configDir}/plugins/${LEGACY_PLUGIN_ID}`;
  }

  private get chatStatePath(): string {
    return `${this.pluginDataDir}/chat-state.json`;
  }

  /** A second copy of the chat state, written first (writeChatState). */
  private get nextChatStatePath(): string {
    return `${this.pluginDataDir}/chat-state.next.json`;
  }

  private get legacyChatStatePath(): string {
    return `${this.legacyPluginDataDir}/chat-state.json`;
  }
}

/** `chat-state.json` as read: any format version (`migrateChatState`). */
interface PersistedChatState {
  version?: number;
  /** When it was written (ms); tells the newer of the two copies. */
  savedAt?: number;
  chatHistory?: unknown;
  agentMessages?: unknown;
  activeConversationId?: unknown;
  conversations?: unknown;
}

function isPersistedChatState(value: unknown): value is PersistedChatState {
  if (!isRecord(value) || Array.isArray(value)) return false;
  if ("version" in value && (typeof value.version !== "number" || !Number.isInteger(value.version) || value.version < 1)) return false;
  if ("savedAt" in value && (typeof value.savedAt !== "number" || !Number.isFinite(value.savedAt) || value.savedAt < 0)) return false;
  // From version 3 on, the two histories are kept per conversation.
  if (typeof value.version === "number" && value.version >= 3) {
    if ("activeConversationId" in value && typeof value.activeConversationId !== "string") return false;
    if (!Array.isArray(value.conversations)) return false;
    const ids = value.conversations.map(conversation => isRecord(conversation) ? conversation.id : undefined);
    if (ids.some(id => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length) return false;
    return value.conversations.every(conversation =>
      isRecord(conversation) && !Array.isArray(conversation) && typeof conversation.id === "string" &&
      isSavedHistories(conversation, false));
  }
  // From version 2 on, image data is saved only in the API history.
  return isSavedHistories(value, typeof value.version !== "number" || value.version < 2);
}

/** A saved chat's `chatHistory` and `agentMessages`: at least one of them, each a list of valid entries. */
function isSavedHistories(value: Record<string, unknown>, imagesWithData: boolean): boolean {
  if (!Array.isArray(value.chatHistory) && !Array.isArray(value.agentMessages)) return false;
  if ("chatHistory" in value && !Array.isArray(value.chatHistory)) return false;
  if ("agentMessages" in value && !Array.isArray(value.agentMessages)) return false;
  if (Array.isArray(value.chatHistory) && !value.chatHistory.every(entry => isChatHistoryEntry(entry, imagesWithData))) return false;
  return !Array.isArray(value.agentMessages) || value.agentMessages.every(message =>
    isRecord(message) && (message.role === "user" || message.role === "assistant") &&
    (!("turnId" in message) || typeof message.turnId === "string") &&
    (typeof message.content === "string" || (Array.isArray(message.content) &&
      message.content.every(block => isRecord(block) && typeof block.type === "string" &&
        (block.type !== "image" || isSavedImage(block.image, true)) &&
        (block.type !== "file" || isSavedFile(block.file, true)) &&
        (!("files" in block) || (Array.isArray(block.files) && block.files.every(file => isSavedFile(file, true)))) &&
        (!("images" in block) || (Array.isArray(block.images) && block.images.every(image => isSavedImage(image, true))))))));
}

function isChatHistoryEntry(entry: unknown, imagesWithData = true): boolean {
  if (!isRecord(entry) || Array.isArray(entry) || typeof entry.type !== "string") return false;
  if ("text" in entry && typeof entry.text !== "string") return false;
  if ("turnId" in entry && typeof entry.turnId !== "string") return false;
  if ("selection" in entry && !isSavedSelection(entry.selection)) return false;
  if (["user", "assistant", "error"].includes(entry.type) && typeof entry.text !== "string") return false;
  if (entry.type === "tool-result" &&
    (typeof entry.toolName !== "string" || entry.toolName.length === 0 || !("toolResult" in entry))) return false;
  if ("toolName" in entry && typeof entry.toolName !== "string") return false;
  if ("toolInput" in entry && (!isRecord(entry.toolInput) || Array.isArray(entry.toolInput))) return false;
  if ("toolResult" in entry && (!isRecord(entry.toolResult) || Array.isArray(entry.toolResult) ||
    typeof entry.toolResult.result !== "string" || typeof entry.toolResult.isError !== "boolean")) return false;
  if ("images" in entry) {
    if (!Array.isArray(entry.images) || !entry.images.every(image => isSavedImage(image, imagesWithData))) return false;
    // Svelte's keyed image list cannot render duplicate attachment IDs.
    const imageIds = entry.images.map((image: unknown) =>
      isRecord(image) && typeof image.id === "string" ? image.id : "");
    if (new Set(imageIds).size !== entry.images.length) return false;
  }
  if ("attachedFiles" in entry) {
    if (!Array.isArray(entry.attachedFiles) || !entry.attachedFiles.every(file => isSavedFile(file, imagesWithData))) return false;
    if (new Set(entry.attachedFiles.map(file => (file as { id: string }).id)).size !== entry.attachedFiles.length) return false;
  }
  if (entry.type === "changes" && (typeof entry.turnId !== "string" || !Array.isArray(entry.files) ||
    !entry.files.every(file => typeof file === "string") || ("undone" in entry && typeof entry.undone !== "boolean"))) return false;
  return true;
}

function isSavedFile(file: unknown, withData: boolean): boolean {
  return isSavedImage(file, withData) && isRecord(file) && (!("text" in file) || typeof file.text === "string");
}

function isSavedImage(image: unknown, withData: boolean): boolean {
  return isRecord(image) && !Array.isArray(image) && typeof image.id === "string" &&
    typeof image.fileName === "string" && typeof image.mediaType === "string" &&
    (typeof image.data === "string" || (!withData && !("data" in image))) && typeof image.sizeBytes === "number" &&
    Number.isFinite(image.sizeBytes) && image.sizeBytes >= 0;
}

function isSavedSelection(value: unknown): boolean {
  if (!isRecord(value) || Array.isArray(value) || typeof value.filePath !== "string" || typeof value.text !== "string") return false;
  if ("sourceText" in value && typeof value.sourceText !== "string") return false;
  if ("sourceHash" in value && (typeof value.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceHash))) return false;
  return ["from", "occurrence"].every(key => !(key in value) ||
    (typeof value[key] === "number" && Number.isInteger(value[key]) && value[key] >= 0));
}

function normalizeSettings(value: unknown): Partial<ChatSettings> {
  if (!isRecord(value)) return {};
  const settings: Partial<ChatSettings> = {};
  if (isProvider(value.provider)) settings.provider = value.provider;
  if (typeof value.apiKey === "string") settings.apiKey = value.apiKey;
  if (typeof value.model === "string") settings.model = value.model;
  if (typeof value.thinkingLevel === "string") settings.thinkingLevel = value.thinkingLevel;
  // Within the settings field's range, 1 to 100, however data.json was edited;
  // below 1 (0 used to mean the default) keeps the default.
  if (typeof value.maxIterations === "number" && Number.isFinite(value.maxIterations) && value.maxIterations >= 1) {
    settings.maxIterations = Math.min(100, Math.floor(value.maxIterations));
  }
  if (typeof value.enableWebSearch === "boolean") settings.enableWebSearch = value.enableWebSearch;
  if (typeof value.enterSends === "boolean") settings.enterSends = value.enterSends;
  if (typeof value.followEdits === "boolean") settings.followEdits = value.followEdits;
  if (typeof value.debugLog === "boolean") settings.debugLog = value.debugLog;
  if (typeof value.skillsFolder === "string" && value.skillsFolder.trim()) settings.skillsFolder = value.skillsFolder.trim();
  if (Array.isArray(value.mcpServers)) {
    // Never a token from data.json (they live in SecretStorage).
    settings.mcpServers = value.mcpServers.filter(isRecord)
      .filter((server) => typeof server.id === "string" && typeof server.name === "string" && typeof server.url === "string")
      .map((server) => ({ id: server.id as string, name: server.name as string, url: server.url as string, enabled: server.enabled === true }));
  }
  settings.modelCatalog = normalizeCatalogState(value.modelCatalog);
  return settings;
}

/** SecretStorage key of an MCP server's token. */
function mcpSecretKey(id: string): string {
  return `${PLUGIN_ID}-mcp-${id}`;
}

function isProvider(value: unknown): value is ChatSettings["provider"] {
  return value === "anthropic" || value === "openai" || value === "chatgpt-oauth";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
