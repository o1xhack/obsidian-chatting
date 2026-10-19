import { ItemView, WorkspaceLeaf, Notice, Platform, Scope, type App } from "obsidian";
import { mount, unmount } from "svelte";
import type { Component } from "svelte";
import type ChatPlugin from "../main";
import ChatContainer from "./ChatContainer.svelte";
import type { AgentCallbacks, ToolResult, SelectionScope, ImageAttachment, FileAttachment, ConversationSummary, ViewTarget, ChatHistoryEntry } from "../types";
import type { ConversationRecord } from "../chat-state";
import type { AgentLoop } from "../agent/loop";
import { showInView } from "./show-in-view";
import { confirmUndo } from "./undo-confirm";
import { ChangeLog } from "../tools/undo";
import { screenAwake } from "../platform/screen-awake";
import { historySelection } from "../selection-history";
import { newTurnId, withoutLargeVisibleToolText } from "../agent/history";
import { mentionContext, mentionedFiles } from "./mentions";
import { attachmentBudgetError } from "../files/attachments";
import { findSkills, invokedSkillsContext, type Skill } from "../agent/skills";

export const VIEW_TYPE_CHAT = "ochatting-view";

const SAVED_INPUT_TEXT = 300;
const SAVED_INPUT_ITEMS = 10;
const SAVED_INPUT_KEYS = 20;

/**
 * A tool call's input as saved with its card, for display only: strings
 * cut to 300 characters, lists to 10 items and objects to 20 keys, so long
 * note content or canvas lists don't bloat `chat-state.json`.
 */
function savedToolInput(input: Record<string, unknown>): Record<string, unknown> {
  const cap = (value: unknown): unknown => {
    if (typeof value === "string") {
      if (value.length <= SAVED_INPUT_TEXT) return value;
      // Don't keep the first half of a surrogate pair (e.g. an emoji).
      const end = /[\uD800-\uDBFF]/.test(value[SAVED_INPUT_TEXT - 1]) ? SAVED_INPUT_TEXT - 1 : SAVED_INPUT_TEXT;
      return `${value.slice(0, end)}... (${value.length} characters)`;
    }
    if (Array.isArray(value)) {
      const items = value.slice(0, SAVED_INPUT_ITEMS).map(cap);
      return value.length > SAVED_INPUT_ITEMS ? [...items, `... (${value.length - SAVED_INPUT_ITEMS} more)`] : items;
    }
    if (typeof value === "object" && value !== null) {
      const entries = Object.entries(value);
      const kept = Object.fromEntries(entries.slice(0, SAVED_INPUT_KEYS).map(([key, item]) => [key, cap(item)]));
      if (entries.length > SAVED_INPUT_KEYS) kept["..."] = `(${entries.length - SAVED_INPUT_KEYS} more)`;
      return kept;
    }
    return value;
  };
  return cap(input) as Record<string, unknown>;
}

interface ChatContainerProps {
  app: App;
  component: ObsidianChatView;
  provider: string;
  model: string;
  onSend: (text: string, selection: SelectionScope | null, images: ImageAttachment[], files: FileAttachment[]) => void;
  onClear: () => void;
  onStop: () => void;
  onEdit: (turnId: string, text: string) => void;
  onRegenerate: () => void;
  onCopy: (text: string) => void;
  title: string;
  onNewChat: () => void;
  listConversations: () => ConversationSummary[];
  onOpenConversation: (id: string) => void;
  onRenameConversation: (id: string, title: string) => void;
  onDeleteConversation: (id: string) => void;
  onToggleFollow: () => void;
  onUndo: (turnId: string) => void;
  listSkills: () => Skill[];
  onContinue: () => void;
}

interface ChatContainerApi extends Record<string, unknown> {
  addUserMessage(text: string, images?: ImageAttachment[], turnId?: string, selection?: SelectionScope, files?: FileAttachment[]): void;
  restoreDraft?(text: string, selection: SelectionScope | null, images: ImageAttachment[], files: FileAttachment[]): void;
  addAssistantMessage(text: string, streaming?: boolean): number;
  /** Replace an assistant message's text; `final` renders it at once and ends its streaming. */
  updateAssistantMessage(id: number, text: string, final?: boolean): void;
  removeMessage(id: number): void;
  cutMessages(turnId: string): void;
  addToolCall(name: string, input: Record<string, unknown>): number;
  updateToolResult(msgId: number, name: string, result: ToolResult): void;
  addError(text: string, errorKind?: "stopped"): void;
  /** The thinking dots, with a short label such as "Resuming…". */
  showThinking(label?: string): void;
  hideThinking(): void;
  /** The next input answers a question; `question` is shown first unless the chat shows it already. */
  showAskUser(question?: string): Promise<string>;
  cancelAskUser(): void;
  setInputEnabled(enabled: boolean): void;
  setBusy(busy: boolean): void;
  setComposerLocked?(locked: boolean): void;
  setRetainedAttachments?(entries: ChatHistoryEntry[]): void;
  /** Messages added to the running turn that the agent hasn't taken in yet. */
  setQueued(texts: string[]): void;
  /** The open chats list again (a chat started or finished answering). */
  updateConversations(): void;
  clearMessages(): void;
  focus(): void;
  setModel(name: string): void;
  setTitle(title: string): void;
  setSelection(selection: SelectionScope): void;
  getSelection(): SelectionScope | null;
  setEnterSends(on: boolean): void;
  /** Offer Continue for a turn that was cut off when Obsidian was ended. */
  setContinue(show: boolean): void;
  /** Ctrl/Cmd+Enter in the chat: sends from the chat input, saves from a message's edit box. */
  sendFromKeyboard(target: EventTarget | null): boolean;
  /** Which turns can be edited or answered again. */
  setEditable?(check: (turnId: string) => boolean): void;
  setFollowEdits(on: boolean): void;
  /** "kept": undo snapshots expired after closing Obsidian or reaching the memory budget. */
  addChanges(turnId: string, files: string[], state: ChangesState): void;
  setChangesUndone(turnId: string): void;
  setChangesKept?(turnId: string): void;
  /** A finished turn: its steps fold into one row above the answer. */
  foldTurn(turnId: string): void;
}

export type ChangesState = "undoable" | "undone" | "kept";

/**
 * A turn in progress, in the shown conversation or another: a turn keeps
 * running when the user switches chats. What appears while it arrives
 * (the streamed answer, running tool steps, the thinking dots, a question)
 * is kept here, so the chat shows it again when the user comes back.
 */
interface RunningTurn {
  conversation: ConversationRecord;
  /** The conversation's visible history when the turn started (edit and Clear replace the array). */
  history: ChatHistoryEntry[];
  agent: AgentLoop;
  /** Some of the answer is on screen (streamed or whole, a step or a question). */
  answerShown: boolean;
  /** The answer being streamed, until the loop delivers it whole; `id` is its message while shown. */
  streaming: { id: number; text: string } | null;
  /** Tool steps still running, by tool name, with their row while shown. */
  tools: Map<string, { id: number; input: Record<string, unknown> }>;
  /** The thinking dots' label ("": just the dots); null: no dots. */
  thinking: string | null;
  /** An `ask_user` question waiting for its answer. */
  ask: ((answer: string) => void) | null;
  /** Typed while it runs, until the agent takes them in or they run next (shown as queued). */
  queued: string[];
  /** Typed when no loop step could take them (the turn was ending): they run next. */
  unsteered: string[];
  /** Lets the screen sleep again (the turn holds it on). */
  releaseScreen: () => void;
  /** Past its preflight (linked files read, the request allowed): its user row is in the history. */
  started: boolean;
  /** An edit's original turn, put back if the new one is stopped or refused before any answer. */
  rollback?: () => void;
  /** Puts the unsent message back in the input, until the turn has started. */
  /** Puts the unsent message back in the input, with `queued` texts typed meanwhile, until the turn has started (an edit: until answered). */
  restoreDraft?: (queued: string[]) => void;
}

/**
 * Chat view for Chatting with AI.
 * Desktop: right sidebar. Mobile: right sidebar (slides in from edge).
 * Uses the plugin's conversations and agent loops, so chats and running
 * turns survive switching and the view being closed and reopened (e.g.
 * sidebar toggle).
 */
export class ObsidianChatView extends ItemView {
  private plugin: ChatPlugin;
  private chatContainer: ChatContainerApi | undefined;
  /**
   * The running turn of each conversation, by its ID. A turn is current
   * while it is its conversation's entry here: Stop, Clear and edit remove
   * or replace it, and a stopped turn that ends late changes nothing.
   */
  private turns = new Map<string, RunningTurn>();
  /** Resolves once onOpen() has mounted the chat UI, or failed to. */
  readonly ready: Promise<void>;
  private markReady!: () => void;

  constructor(leaf: WorkspaceLeaf, plugin: ChatPlugin) {
    super(leaf);
    this.plugin = plugin;
    this.ready = new Promise((resolve) => { this.markReady = resolve; });
    // Obsidian takes Ctrl/Cmd+Enter as a hotkey before the input sees it.
    // The view's own scope is asked first, so the chat still sends with it.
    this.scope = new Scope(this.app?.scope);
    this.scope.register(["Mod"], "Enter", (evt) => this.chatContainer?.sendFromKeyboard(evt.target) ? false : true);
  }

  getViewType(): string {
    return VIEW_TYPE_CHAT;
  }

  /** The shown conversation's running turn. */
  private get turn(): RunningTurn | undefined {
    return this.turns.get(this.plugin.activeConversationId);
  }

  /** The shown conversation runs a turn. */
  get running(): boolean {
    return !!this.turn;
  }

  /** The chat UI while it shows `turn`'s conversation (and `turn` still runs there). */
  private shownChat(turn: RunningTurn): ChatContainerApi | undefined {
    return this.turn === turn ? this.chatContainer : undefined;
  }

  getDisplayText(): string {
    // Distinct from upstream "Chat" tab so users running both plugins
    // side-by-side can tell the workspace tabs apart.
    return "Chatting with AI";
  }

  getIcon(): string {
    return "message-circle";
  }

  async onOpen(): Promise<void> {
    try {
      this.mountChat();
      this.followKeyboardOnPhone();
    } finally {
      // Also when mounting failed: commands waiting for the view go on
      // (its methods do nothing without the UI) instead of waiting forever.
      this.markReady();
    }
  }

  /**
   * Phones: Obsidian doesn't shrink the sidebar for the keyboard, it only
   * sets --keyboard-height (and drops the sidebar's bottom padding). With
   * the keyboard open, measure how much of the view it covers and lift the
   * chat by that (`--ochatting-lift`, styles.css). Measured, not predicted:
   * whatever lies below the view, the input ends at the keyboard. Runs when
   * Obsidian changes the keyboard state (its style and class on <html> and
   * <body>) and when the view's size changes.
   */
  private followKeyboardOnPhone(): void {
    if (!Platform.isPhone) return;
    const view = this.contentEl;
    const update = () => {
      const keyboard = Number.parseFloat(getComputedStyle(document.body).getPropertyValue("--keyboard-height")) || 0;
      const rect = view.getBoundingClientRect();
      const lift = keyboard > 0 && rect.height > 0 ? Math.max(0, Math.round(rect.bottom - (window.innerHeight - keyboard))) : 0;
      view.style.setProperty("--ochatting-lift", `${lift}px`);
    };
    const resize = new ResizeObserver(update);
    resize.observe(view);
    const keyboardState = new MutationObserver(update);
    for (const el of [document.documentElement, document.body]) {
      keyboardState.observe(el, { attributes: true, attributeFilter: ["style", "class"] });
    }
    this.register(() => {
      resize.disconnect();
      keyboardState.disconnect();
    });
  }

  private mountChat(): void {
    const container = this.contentEl;
    container.empty();
    container.addClass("ochatting-view-container");

    this.chatContainer = mount<ChatContainerProps, ChatContainerApi>(
      ChatContainer as unknown as Component<ChatContainerProps, ChatContainerApi>,
      {
      target: container,
      props: {
        app: this.app,
        component: this,
        provider: this.plugin.settings.provider,
        model: this.plugin.modelHeaderLabel(),
        onSend: (text: string, selection: SelectionScope | null, images: ImageAttachment[], files: FileAttachment[]) => {
          void this.handleUserMessage(text, selection, images, files);
        },
        onClear: () => this.handleClear(),
        onStop: () => this.handleStop(),
        onEdit: (turnId: string, text: string) => void this.editMessage(turnId, text),
        onRegenerate: () => void this.regenerate(),
        onCopy: (text: string) => this.copyAnswer(text),
        title: this.plugin.activeConversation.title,
        onNewChat: () => this.newChat(),
        listConversations: () => this.plugin.listConversations().map((item) => ({ ...item, running: this.turns.has(item.id) })),
        onOpenConversation: (id: string) => this.openConversation(id),
        onRenameConversation: (id: string, title: string) => this.renameConversation(id, title),
        onDeleteConversation: (id: string) => this.deleteConversation(id),
        onToggleFollow: () => void this.toggleFollow(),
        onUndo: (turnId: string) => void this.undoChanges(turnId),
        listSkills: () => findSkills(this.plugin.app, this.plugin.settings.skillsFolder),
        onContinue: () => void this.continueTurn(),
      },
    });

    this.renderHistory();
    this.updateEnterSends();
    this.updateFollowEdits();
    this.chatContainer.focus();
  }

  /**
   * Show the active conversation's history in the UI, replacing what it
   * shows, and what its running turn shows so far.
   */
  renderHistory(): void {
    const chat = this.chatContainer;
    if (!chat) return;
    chat.clearMessages();
    for (const msg of this.plugin.chatHistory) {
      switch (msg.type) {
        case "user":
          chat.addUserMessage(msg.text ?? "", msg.images, msg.turnId, msg.selection, msg.attachedFiles);
          break;
        case "assistant":
          chat.addAssistantMessage(msg.text!);
          break;
        case "tool-result":
          if (msg.toolName && msg.toolResult) {
            const id = chat.addToolCall(msg.toolName, msg.toolInput || {});
            chat.updateToolResult(id, msg.toolName, msg.toolResult);
          }
          break;
        case "error":
          chat.addError(msg.text!, msg.errorKind);
          break;
        case "changes":
          if (msg.turnId) {
            const state = msg.undone ? "undone" : this.plugin.changeLogs.get(msg)?.canUndo() ? "undoable" : "kept";
            chat.addChanges(msg.turnId, msg.files ?? [], state);
          }
          break;
      }
    }
    // Finished turns show folded; a running one is the last and stays open.
    const turnIds = this.plugin.chatHistory.flatMap((entry) => entry.type === "user" && entry.turnId ? [entry.turnId] : []);
    for (const turnId of this.running ? turnIds.slice(0, -1) : turnIds) chat.foldTurn(turnId);
    // The running turn's steps, answer and dots as far as they got.
    const turn = this.turn;
    if (turn) {
      for (const [name, call] of turn.tools) call.id = chat.addToolCall(name, call.input);
      if (turn.streaming) turn.streaming.id = chat.addAssistantMessage(turn.streaming.text, true);
      if (turn.thinking !== null) chat.showThinking(turn.thinking);
    }
    // Turns the API history no longer holds lose their pencil.
    this.updateEditable();
    chat.setContinue(this.canContinue());
  }

  /**
   * The shown conversation's turn was cut off (Obsidian was ended in the
   * middle of it) and the model still owes an answer.
   */
  private canContinue(): boolean {
    const pending = this.plugin.activeConversation.pendingTurn;
    return !this.running && !!pending && this.plugin.agent.owesAnswer(pending.turnId);
  }

  /** Forget a cut-off turn: no Continue (a new message, Stop, Clear, leaving the chat). */
  private dismissContinue(): void {
    delete this.plugin.activeConversation.pendingTurn;
    this.chatContainer?.setContinue(false);
  }

  /** Turns the API history no longer holds lose their pencil and Regenerate. */
  private updateEditable(): void {
    const agent = this.plugin.agent;
    this.chatContainer?.setEditable?.((turnId) => agent.canEditTurn(turnId));
  }

  async onClose(): Promise<void> {
    this.handleStop();
    // The turns in the background stop too: they show and save through this view.
    for (const turn of [...this.turns.values()]) this.stopTurn(turn);
    if (this.chatContainer) {
      await unmount(this.chatContainer);
      this.chatContainer = undefined;
    }
  }

  /** Programmatically send a message */
  sendMessage(text: string): void {
    void this.handleUserMessage(text, this.chatContainer?.getSelection() ?? null);
  }

  /** Set the selection scope and show the pill */
  setSelection(selection: SelectionScope): void {
    this.chatContainer?.setSelection(selection);
  }

  /** Focus the input */
  focus(): void {
    this.chatContainer?.focus();
  }

  /** Update the model display name in the header */
  updateModel(name: string): void {
    this.chatContainer?.setModel(name);
  }

  /** Release expired payloads also held by mounted thumbnails, without
   * resetting the composer, tool steps, or an in-flight ask_user. */
  refreshAttachmentData(): void {
    this.chatContainer?.setRetainedAttachments?.(this.plugin.chatHistory);
  }

  /** Enter sends, or starts a new line (the "Enter sends message" setting). */
  updateEnterSends(): void {
    this.chatContainer?.setEnterSends(this.plugin.settings.enterSends);
  }

  /** The eye button in the header shows the "Follow the AI's edits" setting. */
  updateFollowEdits(): void {
    this.chatContainer?.setFollowEdits(this.plugin.settings.followEdits);
  }

  /** The eye button: the "Follow the AI's edits" setting, on or off. */
  private async toggleFollow(): Promise<void> {
    this.plugin.settings.followEdits = !this.plugin.settings.followEdits;
    await this.plugin.saveSettings();
  }

  /** Clear conversation */
  clearConversation(): void {
    this.handleClear();
  }

  // ─── Conversations ──────────────────────────────────────────────────
  // A running turn keeps running when the user switches: it goes on in its
  // conversation, which shows it again on the return.

  /** Start a new conversation (an empty current one is kept instead). */
  newChat(): void {
    if (this.undoing) return;
    const restore = this.cancelPreflight();
    if (!this.running) this.dismissContinue();
    this.plugin.startNewConversation();
    this.showConversation();
    // After rendering, which clears the input's attachments.
    restore?.();
  }

  /** Switch to conversation `id`. */
  openConversation(id: string): void {
    if (this.undoing) return;
    if (id === this.plugin.activeConversationId) return;
    const restore = this.cancelPreflight();
    if (!this.running) this.dismissContinue();
    this.plugin.openConversation(id);
    this.showConversation();
    // After rendering, which clears the input's attachments.
    restore?.();
  }

  /** Rename conversation `id` (empty: back to the automatic title). */
  renameConversation(id: string, title: string): void {
    this.plugin.renameConversation(id, title);
    this.chatContainer?.setTitle(this.plugin.activeConversation.title);
  }

  /** Delete conversation `id`; for the current one, show the next. */
  deleteConversation(id: string): void {
    if (this.undoing) return;
    const active = id === this.plugin.activeConversationId;
    // Its turn stops, shown or not.
    const turn = this.turns.get(id);
    if (turn) this.stopTurn(turn);
    this.plugin.deleteConversation(id);
    if (active) this.showConversation();
  }

  /**
   * Show the active conversation: its history, and its running turn as far
   * as it got (the input adds to it, a waiting question can be answered).
   */
  private showConversation(): void {
    const chat = this.chatContainer;
    if (!chat) return;
    // The input stops waiting for another conversation's answer (its question waits).
    chat.cancelAskUser();
    this.renderHistory();
    chat.setTitle(this.plugin.activeConversation.title);
    const turn = this.turn;
    chat.setInputEnabled(true);
    chat.setBusy(!!turn);
    chat.setQueued([...turn?.queued ?? []]);
    if (turn?.ask) this.askNow(turn);
    chat.focus();
    // Typed after its turn's last step while it ran in the background: they run now.
    const conversation = this.plugin.activeConversation;
    const later = conversation.pendingMessages;
    if (later?.length && !turn) {
      delete conversation.pendingMessages;
      void this.handleUserMessage(later.join("\n\n"), null);
    }
  }

  /**
   * Edit and continue: stop a running turn, cut both histories to
   * just before the turn `turnId`, and run `text` as a new turn with
   * that turn's images, files and selection scope. Vault changes stay. Resolves
   * when the new turn has ended. Stopped or refused before any answer, the
   * original turn comes back.
   */
  async editMessage(turnId: string, text: string): Promise<void> {
    if (this.undoing || !this.chatContainer) return;
    const running = this.turn;
    if (running) this.stopTurn(running);
    const history = this.plugin.chatHistory;
    const index = history.findIndex((entry) => entry.type === "user" && entry.turnId === turnId);
    const agent = this.plugin.agent;
    // A turn the API history no longer holds can't be edited: cutting there
    // would leave the model without the chat.
    if (index < 0 || !agent.canEditTurn(turnId)) return;
    const { selection = null } = history[index];
    // Images and files the saved API history no longer holds can't be sent again.
    const images = (history[index].images ?? []).filter((image) => image.data);
    const files = (history[index].attachedFiles ?? []).filter((file) => file.data || file.text);
    if (!text.trim() && images.length === 0 && files.length === 0) return;
    const originalMessages = agent.exportMessages(Number.MAX_SAFE_INTEGER);
    const conversation = this.plugin.activeConversation;
    const originalTitle = conversation.title;
    const originalAutomaticTitle = conversation.automaticTitle;
    const originalTitleSource = conversation.titleSourceTurnId;
    const originalUpdatedAt = conversation.updatedAt;
    const originalNotes = conversation.notes ?? [];
    agent.cutBeforeTurn(turnId);
    conversation.chatHistory = history.slice(0, index);
    if (history[index].turnId === conversation.titleSourceTurnId) delete conversation.titleSourceTurnId;
    const replacementHistory = conversation.chatHistory;
    // In its own conversation, also when another one is shown by then.
    const rollback = () => {
      agent.importMessages(originalMessages);
      conversation.chatHistory = history;
      conversation.title = originalTitle;
      conversation.automaticTitle = originalAutomaticTitle;
      conversation.titleSourceTurnId = originalTitleSource;
      conversation.updatedAt = originalUpdatedAt;
      if (originalNotes.length) conversation.notes = [...new Set([...originalNotes, ...conversation.notes ?? []])];
      // Preserve the rejection explanation alongside the original conversation.
      history.push(...replacementHistory.slice(index).filter(row => row.type === "error"));
      if (this.plugin.activeConversationId === conversation.id) {
        this.renderHistory();
        this.chatContainer?.setTitle(conversation.title);
      }
      void this.plugin.saveChatHistory();
    };
    this.chatContainer?.cutMessages(turnId);
    await this.handleUserMessage(text, selection, images, files, history[index].linkSource ?? "", rollback);
  }

  /** Regenerate the last answer: run the last user turn again, unchanged. */
  async regenerate(): Promise<void> {
    const last = this.plugin.chatHistory.filter((entry) => entry.type === "user" && entry.turnId).pop();
    if (last?.turnId) await this.editMessage(last.turnId, last.text ?? "");
  }

  /** Copy an answer's Markdown source. */
  copyAnswer(text: string): void {
    void navigator.clipboard.writeText(text).then(
      () => new Notice("Copied"),
      () => new Notice("Couldn't copy the answer."),
    );
  }

  private async handleUserMessage(
    text: string,
    selection: SelectionScope | null,
    images: ImageAttachment[] = [],
    files: FileAttachment[] = [],
    linkSource = this.plugin.app.workspace.getActiveFile()?.path ?? "",
    rollback?: () => void
  ): Promise<void> {
    // An undo is running: the message waits in the input.
    if (this.undoing) {
      this.chatContainer?.restoreDraft?.(text, selection, images, files);
      new Notice("Please wait for the current response to complete.");
      return;
    }
    // While a turn runs, a typed message is added to it (steering).
    if (this.running) {
      this.addToRunningTurn(text);
      return;
    }

    const chat = this.chatContainer;
    if (!chat) {
      // No UI (mounting it failed): nothing to show the turn in.
      new Notice("The chat panel couldn't be shown, so the message wasn't sent.");
      return;
    }
    const conversation = this.plugin.activeConversation;
    const turnId = newTurnId();
    const savedSelection = selection ? historySelection(selection) : undefined;
    // What the model should know of (an undo), told once, with this turn.
    const notes = conversation.notes ?? [];
    delete conversation.notes;
    await this.runTurn(turnId, async (agent, callbacks, { isCurrent, begin }) => {
      // The files the message links to go along as they are now; the chat
      // shows only the typed text.
      const app = this.plugin.app;
      const linked = await mentionContext(app, mentionedFiles(app, text, linkSource), { images, files });
      if (!isCurrent()) return;
      // Skills named as /name go along loaded, before the linked files.
      const skills = await invokedSkillsContext(app, this.plugin.settings.skillsFolder, text);
      if (!isCurrent()) return;
      const mentioned = skills
        ? { text: linked ? `${skills.text}\n\n${linked.text}` : skills.text, images: linked?.images ?? [], files: linked?.files ?? [],
            instructionPaths: [...skills.instructionPaths ?? [], ...linked?.instructionPaths ?? []] }
        : linked;
      const budgetError = attachmentBudgetError([...images, ...mentioned?.images ?? []], [...files, ...mentioned?.files ?? []]);
      if (budgetError) {
        chat.addError(budgetError);
        conversation.chatHistory.push({ type: "error", text: budgetError });
        return;
      }
      // Only consume the submitted draft after its linked context is valid.
      // A rejected draft must not become an uneditable visible-only turn.
      // (A switch during the preflight stopped the turn, so it is shown here.)
      chat.addUserMessage(text, images, turnId, savedSelection, files);
      conversation.chatHistory.push({ type: "user", text, images, turnId, linkSource, ...(savedSelection ? { selection: savedSelection } : {}), ...(files.length ? { attachedFiles: files } : {}) });
      this.plugin.touchConversation();
      chat.setTitle(conversation.title);
      begin();
      await agent.run(text, callbacks, selection, images, turnId, mentioned, notes, files);
    }, { text, selection, images, files, notes, rollback });
  }

  /**
   * Continue the turn that was cut off when Obsidian was ended in the
   * middle of it: the agent runs on its history as saved, with no new user
   * message; tool results already there aren't run again.
   */
  async continueTurn(): Promise<void> {
    const pending = this.plugin.activeConversation.pendingTurn;
    if (!pending || !this.canContinue()) return;
    await this.runTurn(pending.turnId, (agent, callbacks) => agent.continueTurn(callbacks));
  }

  /**
   * Run turn `turnId` of the shown conversation through `start`, with its
   * agent loop and the view's callbacks. Progress, tool steps and the
   * answer go to the conversation's history, and to the chat while it shows
   * that conversation: the turn goes on when the user switches. Saved at
   * the end. While it runs, the conversation carries it as its pending turn.
   *
   * `draft`: a new message, not yet in the history. Until `start` calls
   * `begin()` (its linked files read and allowed), Stop or a switch puts it
   * back in the input, and an edit's original turn comes back (`rollback`).
   */
  private async runTurn(
    turnId: string,
    start: (agent: AgentLoop, callbacks: AgentCallbacks, turn: { isCurrent: () => boolean; begin: () => void }) => Promise<void>,
    draft?: { text: string; selection: SelectionScope | null; images: ImageAttachment[]; files: FileAttachment[]; notes: string[]; rollback?: () => void },
  ): Promise<void> {
    const chat = this.chatContainer;
    if (!chat) return;
    const conversation = this.plugin.activeConversation;
    const agent = this.plugin.agentFor(conversation);
    // Kept by the plugin while it runs, also when the user switches away.
    const release = agent.hold();
    const turn: RunningTurn = {
      conversation, history: conversation.chatHistory, agent, answerShown: false,
      streaming: null, tools: new Map(), thinking: null, ask: null, queued: [], unsteered: [],
      // The screen stays on while the answer is generated.
      releaseScreen: screenAwake.hold(),
      started: !draft, rollback: draft?.rollback,
    };
    this.turns.set(conversation.id, turn);
    chat.updateConversations();
    // Stop, Clear, edit and deleting the chat end a turn early; it may still
    // end later (a request in flight), and then changes nothing.
    const isCurrent = () => this.turns.get(conversation.id) === turn;
    const ui = () => this.shownChat(turn);
    const history = turn.history;
    // Saved with the chat when the app goes to the background; still there
    // at the next start, the turn was cut off. A new message only once it
    // is sent (`begin`).
    if (!draft) conversation.pendingTurn = { turnId, startedAt: Date.now() };
    chat.setContinue(false);
    // The input stays usable: what is sent now is added to this turn.
    chat.setBusy(true);

    const changes = new ChangeLog();
    let notesRestored = false;
    const restoreNotes = () => {
      if (!notesRestored && draft?.notes.length) conversation.notes = [...new Set([...draft.notes, ...conversation.notes ?? []])];
      notesRestored = true;
    };
    if (draft) {
      turn.restoreDraft = (queued) => {
        restoreNotes();
        chat.restoreDraft?.([draft.text, ...queued].join("\n\n"), draft.selection, draft.images, draft.files);
      };
    }
    const begin = () => {
      turn.started = true;
      conversation.pendingTurn = { turnId, startedAt: Date.now() };
      // An edit keeps its draft until answered: stopped before, it goes back to the input.
      if (!turn.rollback) turn.restoreDraft = undefined;
    };
    // The first sign of an answer: the edit's original turn can't come back any more.
    const answering = () => {
      turn.rollback = undefined;
      turn.restoreDraft = undefined;
    };

    try {
      await start(agent, {
        changes,
        onPreflightRejected: (error) => {
          turn.started = false;
          const pending = history.findIndex(row => row.type === "user" && row.turnId === turnId);
          if (pending !== -1) history.splice(pending);
          const shown = ui();
          if (shown) {
            shown.cutMessages(turnId);
            this.plugin.touchConversation();
            shown.setTitle(conversation.title);
          }
          this.setThinking(turn, null);
          shown?.addError(error);
          history.push({ type: "error", text: error });
        },
        onThinking: () => {
          // Streamed text the loop didn't deliver (a cut-off stream) goes before the next request.
          this.endStream(turn, false);
          this.setThinking(turn, "");
        },
        // A request that failed or stalled in the background is sent again:
        // the failed attempt's streamed text goes, the answer streams anew.
        onResuming: () => {
          this.endStream(turn, false);
          this.setThinking(turn, "Resuming…");
        },
        onTextDelta: (delta) => {
          answering();
          turn.answerShown = true;
          this.setThinking(turn, null);
          const shown = ui();
          if (turn.streaming) {
            turn.streaming.text += delta;
            shown?.updateAssistantMessage(turn.streaming.id, turn.streaming.text);
          } else {
            turn.streaming = { id: shown ? shown.addAssistantMessage(delta, true) : -1, text: delta };
          }
        },
        onToolCall: (name, input) => {
          answering();
          this.setThinking(turn, null);
          // Streamed text the loop didn't deliver (it precedes ask_user,
          // which shows the question itself) is dropped, as before streaming.
          this.endStream(turn, false);
          if (name === "ask_user") return;
          // A tool step on screen shows that the turn did something.
          turn.answerShown = true;
          turn.tools.set(name, { id: ui()?.addToolCall(name, input) ?? -1, input });
        },
        onToolResult: (name, { focus, ...result }: ToolResult) => {
          if (name === "ask_user") return;
          const call = turn.tools.get(name);
          turn.tools.delete(name);
          if (call) ui()?.updateToolResult(call.id, name, result);
          history.push({ type: "tool-result", toolName: name, toolInput: savedToolInput(call?.input ?? {}), toolResult: result });
          const bounded = withoutLargeVisibleToolText(history);
          if (bounded !== history) for (let i = 0; i < history.length; i++) history[i] = bounded[i];
          if (focus && !result.isError && this.plugin.settings.followEdits) this.follow(focus);
        },
        onResponse: (text) => {
          answering();
          turn.answerShown = true;
          this.setThinking(turn, null);
          // The whole text replaces the streamed one: the same message as unstreamed.
          const shown = ui();
          if (turn.streaming) shown?.updateAssistantMessage(turn.streaming.id, text, true);
          else shown?.addAssistantMessage(text);
          turn.streaming = null;
          history.push({ type: "assistant", text });
        },
        onAskUser: async (question) => {
          answering();
          // The question is the answer so far.
          turn.answerShown = true;
          this.setThinking(turn, null);
          this.endStream(turn, false);
          // The chat shows the question and the typed answer; keep both in
          // the history so they are still there after a reload.
          history.push({ type: "assistant", text: question });
          // Answered in its conversation: now, or when the user comes back to it.
          const answer = await new Promise<string>((resolve) => {
            turn.ask = resolve;
            if (ui()) this.askNow(turn, question);
            else new Notice(`"${conversation.title}" has a question for you.`);
          });
          // Empty: Stop, Clear or deleting the chat dropped the question.
          if (!answer || !isCurrent()) return "";
          history.push({ type: "user", text: answer });
          return answer;
        },
        onError: (error) => {
          this.setThinking(turn, null);
          this.endStream(turn, true);
          ui()?.addError(error);
          history.push({ type: "error", text: error });
        },
        // Added to the running turn: shown where the agent took it in.
        onSteered: (text) => {
          this.endStream(turn, false);
          ui()?.addUserMessage(text);
          history.push({ type: "user", text });
          const index = turn.queued.indexOf(text);
          if (index >= 0) this.showQueued(turn, turn.queued.filter((_, i) => i !== index));
        },
      }, { isCurrent, begin });
    } catch (e) {
      if (!isCurrent()) return;
      if (turn.rollback) turn.started = false;
      const msg = e instanceof Error ? e.message : String(e);
      ui()?.addError(`Unexpected error: ${msg}`);
      history.push({ type: "error", text: `Unexpected error: ${msg}` });
    } finally {
      turn.restoreDraft = undefined;
      if (draft && !turn.started && isCurrent()) {
        // Never sent: the edit's original turn and the message come back.
        restoreNotes();
        const back = turn.rollback;
        turn.rollback = undefined;
        back?.();
        // Rollback renders history, which clears attachment chips. Restore after it.
        // Typed meanwhile, added to a message that was never sent: back in the input with it.
        const unsent = [draft.text, ...this.takeLeftovers(turn)].join("\n\n");
        if (ui()) chat.restoreDraft?.(unsent, draft.selection, draft.images, draft.files);
        else conversation.chatHistory.push({ type: "error", text: `This message wasn't sent: "${unsent}"` });
      }
      turn.releaseScreen();
      release();
      if (conversation.pendingTurn?.turnId === turnId) delete conversation.pendingTurn;
      if (!changes.isEmpty()) this.addChanges(history, turnId, changes);
      // The turn is over: its steps fold into one row above the answer
      // (when the chat shows its conversation; a stopped turn too).
      if (this.plugin.activeConversationId === conversation.id) this.chatContainer?.foldTurn(turnId);
      if (isCurrent()) {
        const shown = ui();
        // Typed after the turn's last step: they run as the next turn, here
        // or when its conversation is shown again.
        const later = this.takeLeftovers(turn);
        this.turns.delete(conversation.id);
        this.chatContainer?.updateConversations();
        if (shown) {
          // The history's limit may have cut older turns off.
          this.updateEditable();
          if (!changes.isEmpty()) {
            for (const row of this.plugin.chatHistory) {
              if (row.type === "changes" && row.turnId && !row.undone && this.plugin.changeLogs.get(row)?.canUndo() === false) {
                shown.setChangesKept?.(row.turnId);
              }
            }
          }
          shown.setInputEnabled(true);
          shown.setBusy(false);
          shown.focus();
        } else {
          new Notice(`Answer ready in "${conversation.title}".`);
        }
        // Not shown: saved with the chat, they run when it's shown again.
        if (later.length && !shown) conversation.pendingMessages = [...conversation.pendingMessages ?? [], ...later];
        // Persist after each turn
        void this.plugin.saveChatHistory();
        if (later.length && shown) void this.handleUserMessage(later.join("\n\n"), null);
      }
    }
  }

  /** The thinking dots with `label`, or none (null); shown while the chat shows the turn. */
  private setThinking(turn: RunningTurn, label: string | null): void {
    turn.thinking = label;
    const chat = this.shownChat(turn);
    if (label === null) chat?.hideThinking();
    else chat?.showThinking(label);
  }

  /**
   * Let the user answer `turn`'s question in the input (its conversation is
   * shown). `question`: shown now; without it the chat shows it already.
   */
  private askNow(turn: RunningTurn, question?: string): void {
    const chat = this.chatContainer;
    if (!chat || !turn.ask) return;
    chat.setInputEnabled(true);
    void chat.showAskUser(question).then((answer) => {
      // Switching away cancels the input, not the question: it waits for the return.
      if (!answer && this.turns.get(turn.conversation.id) === turn && !this.shownChat(turn)) return;
      const resolve = turn.ask;
      turn.ask = null;
      resolve?.(answer);
    });
  }

  // ─── Undo per answer ────────────────────────────────────────────────
  // A turn that changed the vault ends in a row listing its files, with an
  // undo button while Obsidian runs (the snapshots are kept in memory only).

  /**
   * Add turn `turnId`'s changes row right after its last tool step, so it
   * comes before the answer that reports the change. The turn ends at the
   * end of `history`, or before a later turn that started meanwhile (Stop,
   * then send again). Shown only if `history` is the conversation on screen.
   */
  private addChanges(history: ChatHistoryEntry[], turnId: string, changes: ChangeLog): void {
    const entry: ChatHistoryEntry = { type: "changes", turnId, files: changes.files() };
    this.plugin.changeLogs.set(entry, changes);
    if (!changes.canUndo()) new Notice("Undo snapshots exceeded their memory budget. This answer's files are kept; undo is unavailable.");
    const start = history.findIndex((item) => item.type === "user" && item.turnId === turnId);
    const later = history.findIndex((item, i) => i > start && item.type === "user" && !!item.turnId && item.turnId !== turnId);
    const end = later === -1 ? history.length : later;
    let at = end;
    for (let i = end - 1; i > start; i--) {
      if (history[i].type === "tool-result") {
        at = i + 1;
        break;
      }
    }
    history.splice(at, 0, entry);
    // The chat puts the row at the same place (ChatContainer.addChanges).
    if (history === this.plugin.chatHistory) this.chatContainer?.addChanges(turnId, entry.files ?? [], changes.canUndo() ? "undoable" : "kept");
  }

  /**
   * Undo the vault changes of turn `turnId` of the conversation on screen
   * (another conversation's rows aren't found). Files changed since (by
   * the user or a later answer) are named first and change back only if
   * the user agrees. The model is told with the conversation's next turn.
   */
  private undoing = false;

  async undoChanges(turnId: string): Promise<void> {
    if (this.running || this.undoing) return;
    const conversation = this.plugin.activeConversation;
    const entry = conversation.chatHistory.find((item) => item.type === "changes" && item.turnId === turnId);
    const log = entry && this.plugin.changeLogs.get(entry);
    if (!entry || !log || entry.undone) return;
    if (!log.canUndo()) {
      this.renderHistory();
      new Notice("Undo snapshots expired because their memory budget was exceeded. The files are kept.");
      return;
    }
    const app = this.plugin.app;
    const chat = this.chatContainer;
    this.undoing = true;
    chat?.setComposerLocked?.(true);
    chat?.setBusy(true);
    try {
      const changed = await log.conflicts(app);
      if (changed.length && !await confirmUndo(app, changed)) return;
      if (this.running || this.plugin.activeConversation !== conversation || this.plugin.changeLogs.get(entry) !== log) return;
      const failed = await log.undo(app);
      const complete = log.isEmpty();
      if (complete) {
        this.plugin.changeLogs.delete(entry);
        entry.undone = true;
        this.chatContainer?.setChangesUndone(turnId);
      }
      const files = (entry.files ?? []).join(", ");
      const note = complete
        ? `The user undid the changes one of your earlier answers in this chat made to ${files}: they are back as they were before that answer.`
        : `The user tried to undo an earlier answer's changes to ${files}, but undo stopped before completion: ${failed.join("; ")}. Read the current files before making further changes.`;
      conversation.notes = [...conversation.notes ?? [], note];
      if (failed.length) new Notice(`Couldn't undo all changes. You can retry:\n${failed.join("\n")}`);
      void this.plugin.saveChatHistory();
    } catch (error) {
      new Notice(`Couldn't undo changes: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.undoing = false;
      if (this.chatContainer === chat) {
        chat?.setComposerLocked?.(false);
        chat?.setBusy(false);
      }
    }
  }

  /** Edits shown one after another, in the order the AI made them. */
  private following: Promise<unknown> = Promise.resolve();

  /** Show an edit the AI just made (setting "Follow the AI's edits"). */
  private follow(target: ViewTarget): void {
    this.following = this.following.then(() => showInView(this.plugin.app, target)).catch(() => undefined);
  }

  /**
   * Ends the streamed message the loop hasn't delivered whole: kept (and
   * saved for display) when the turn was stopped or failed, else removed.
   */
  private endStream(turn: RunningTurn, keep: boolean): void {
    const stream = turn.streaming;
    if (!stream) return;
    turn.streaming = null;
    const chat = this.shownChat(turn);
    if (keep) {
      chat?.updateAssistantMessage(stream.id, stream.text, true);
      turn.history.push({ type: "assistant", text: stream.text });
    } else {
      chat?.removeMessage(stream.id);
    }
  }

  /** A message typed while the shown turn runs: the agent takes it in after its current step. */
  private addToRunningTurn(text: string): void {
    const turn = this.turn;
    if (!turn) return;
    this.showQueued(turn, [...turn.queued, text]);
    if (!turn.agent.steer(text)) turn.unsteered.push(text);
  }

  /** Added messages the turn didn't take in; they leave the queue (they run next). */
  private takeLeftovers(turn: RunningTurn): string[] {
    const later = [...turn.unsteered.splice(0), ...turn.agent.takeSteered()];
    if (later.length) this.showQueued(turn, turn.queued.filter((text) => !later.includes(text)));
    return later;
  }

  /** `turn`'s queue, shown while the chat shows its conversation. */
  private showQueued(turn: RunningTurn, texts: string[]): void {
    turn.queued = texts;
    this.shownChat(turn)?.setQueued([...texts]);
  }

  /**
   * Before a switch or a new chat: a message still in its preflight (its
   * linked files being read), or an edit not yet answered, is stopped and
   * goes back to the input. An answer under way keeps running.
   */
  private cancelPreflight(): (() => void) | undefined {
    const turn = this.turn;
    return turn && (!turn.started || turn.rollback) ? this.stopTurn(turn, true) : undefined;
  }

  /**
   * Stops `turn` (shown or in the background): what it showed so far
   * stays; what was added to it and a waiting question are dropped. Not
   * yet answered, an edit's original turn and the unsent message come back,
   * with what was typed meanwhile. `deferRestore`: the input is filled by
   * the returned function instead (after the next conversation rendered).
   */
  private stopTurn(turn: RunningTurn, deferRestore = false): (() => void) | undefined {
    const restoreDraft = turn.restoreDraft;
    const rollback = turn.rollback;
    turn.restoreDraft = undefined;
    turn.rollback = undefined;
    const queued = [...turn.queued];
    const shown = this.shownChat(turn);
    turn.unsteered = [];
    if (turn.queued.length) this.showQueued(turn, []);
    turn.agent.abort();
    this.endStream(turn, true);
    this.setThinking(turn, null);
    // A stopped request may still be waiting for its response.
    turn.releaseScreen();
    this.turns.delete(turn.conversation.id);
    this.chatContainer?.updateConversations();
    delete turn.conversation.pendingTurn;
    shown?.setContinue(false);
    const ask = turn.ask;
    turn.ask = null;
    ask?.("");
    // Otherwise the next message would answer the stopped turn's question.
    shown?.cancelAskUser();
    rollback?.();
    // Rollback renders history, which clears attachment chips. Restore after it.
    const restore = shown && restoreDraft ? () => restoreDraft(queued) : undefined;
    if (deferRestore) return restore;
    restore?.();
    return undefined;
  }

  private handleStop(): void {
    const turn = this.turn;
    // Nothing of the answer is on screen yet: say that the turn was stopped.
    const silent = !!turn && !turn.answerShown;
    if (turn) this.stopTurn(turn);
    this.dismissContinue();
    const chat = this.chatContainer;
    if (chat) {
      if (silent) chat.addError("Stopped.", "stopped");
      chat.setInputEnabled(true);
      chat.setBusy(false);
      chat.focus();
    }
    if (silent) this.plugin.chatHistory.push({ type: "error", text: "Stopped.", errorKind: "stopped" });
    void this.plugin.saveChatHistory();
  }

  private handleClear(): void {
    if (this.undoing) return;
    const turn = this.turn;
    if (turn) {
      // Clear drops the turn: nothing comes back.
      turn.rollback = undefined;
      turn.restoreDraft = undefined;
      this.stopTurn(turn);
    }
    this.dismissContinue();
    delete this.plugin.activeConversation.pendingMessages;
    this.plugin.agent.clear();
    this.plugin.chatHistory = [];
    delete this.plugin.activeConversation.notes;
    this.plugin.touchConversation();
    this.chatContainer?.setTitle(this.plugin.activeConversation.title);
    this.chatContainer?.clearMessages();
    this.chatContainer?.cancelAskUser();
    this.chatContainer?.setInputEnabled(true);
    this.chatContainer?.setBusy(false);
    // Clear persisted state
    void this.plugin.saveChatHistory();
  }
}
