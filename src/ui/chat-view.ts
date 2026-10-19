import { ItemView, WorkspaceLeaf, Notice, Platform, Scope, type App } from "obsidian";
import { mount, unmount } from "svelte";
import type { Component } from "svelte";
import type ChatPlugin from "../main";
import ChatContainer from "./ChatContainer.svelte";
import type { ToolResult, SelectionScope, ImageAttachment, FileAttachment, ConversationSummary, ViewTarget, ChatHistoryEntry } from "../types";
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
}

interface ChatContainerApi extends Record<string, unknown> {
  addUserMessage(text: string, images?: ImageAttachment[], turnId?: string, selection?: SelectionScope, files?: FileAttachment[]): void;
  restoreDraft?(text: string, selection: SelectionScope | null, images: ImageAttachment[], files: FileAttachment[]): void;
  addAssistantMessage(text: string): void;
  cutMessages(turnId: string): void;
  addToolCall(name: string, input: Record<string, unknown>): number;
  updateToolResult(msgId: number, name: string, result: ToolResult): void;
  addError(text: string, errorKind?: "stopped"): void;
  showThinking(): void;
  hideThinking(): void;
  showAskUser(question: string): Promise<string>;
  cancelAskUser(): void;
  setInputEnabled(enabled: boolean): void;
  setBusy(busy: boolean): void;
  setComposerLocked?(locked: boolean): void;
  setRetainedAttachments?(entries: ChatHistoryEntry[]): void;
  clearMessages(): void;
  focus(): void;
  setModel(name: string): void;
  setTitle(title: string): void;
  setSelection(selection: SelectionScope): void;
  getSelection(): SelectionScope | null;
  setEnterSends(on: boolean): void;
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
 * Chat view for Chatting with AI.
 * Desktop: right sidebar. Mobile: right sidebar (slides in from edge).
 * Uses the plugin's shared AgentLoop and chatHistory so conversations
 * survive the view being closed and reopened (e.g. sidebar toggle).
 */
export class ObsidianChatView extends ItemView {
  private plugin: ChatPlugin;
  private chatContainer: ChatContainerApi | undefined;
  private running = false;
  private runVersion = 0;
  /** Some of the running turn's answer is on screen. */
  private answerShown = false;
  /** Lets the screen sleep again (the running turn holds it on). */
  private releaseScreen = (): void => {};
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
        listConversations: () => this.plugin.listConversations(),
        onOpenConversation: (id: string) => this.openConversation(id),
        onRenameConversation: (id: string, title: string) => this.renameConversation(id, title),
        onDeleteConversation: (id: string) => this.deleteConversation(id),
        onToggleFollow: () => void this.toggleFollow(),
        onUndo: (turnId: string) => void this.undoChanges(turnId),
        listSkills: () => findSkills(this.plugin.app, this.plugin.settings.skillsFolder),
      },
    });

    this.renderHistory();
    this.updateEnterSends();
    this.updateFollowEdits();
    this.chatContainer.focus();
  }

  /** Show the active conversation's history in the UI, replacing what it shows. */
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
    // Turns the API history no longer holds lose their pencil.
    this.updateEditable();
  }

  /** Turns the API history no longer holds lose their pencil and Regenerate. */
  private updateEditable(): void {
    const agent = this.plugin.agent;
    this.chatContainer?.setEditable?.((turnId) => agent.canEditTurn(turnId));
  }

  async onClose(): Promise<void> {
    this.handleStop();
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
  // Switching stops a running turn (as Stop does); what it showed stays in
  // its conversation.

  /** Start a new conversation (an empty current one is kept instead). */
  newChat(): void {
    if (this.undoing) return;
    if (this.running) this.stopTurn();
    this.plugin.startNewConversation();
    this.showConversation();
  }

  /** Switch to conversation `id`. */
  openConversation(id: string): void {
    if (this.undoing) return;
    if (id === this.plugin.activeConversationId) return;
    if (this.running) this.stopTurn();
    this.plugin.openConversation(id);
    this.showConversation();
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
    if (active && this.running) this.stopTurn();
    this.plugin.deleteConversation(id);
    if (active) this.showConversation();
  }

  /** Show the active conversation, ready for input. */
  private showConversation(): void {
    const chat = this.chatContainer;
    if (!chat) return;
    chat.cancelAskUser();
    this.renderHistory();
    chat.setTitle(this.plugin.activeConversation.title);
    chat.setInputEnabled(true);
    chat.setBusy(false);
    chat.focus();
  }

  /**
   * Edit and continue: stop a running turn, cut both histories to
   * just before the turn `turnId`, and run `text` as a new turn with
   * that turn's images, files and selection scope. Vault changes stay. Resolves
   * when the new turn has ended. Rejected preflight restores the original histories.
   */
  async editMessage(turnId: string, text: string): Promise<void> {
    if (this.undoing || !this.chatContainer) return;
    if (this.running) this.stopTurn();
    const history = this.plugin.chatHistory;
    const index = history.findIndex((entry) => entry.type === "user" && entry.turnId === turnId);
    // A turn the API history no longer holds can't be edited: cutting there
    // would leave the model without the chat.
    if (index < 0 || !this.plugin.agent.canEditTurn(turnId)) return;
    const { selection = null } = history[index];
    // Images and files the saved API history no longer holds can't be sent again.
    const images = (history[index].images ?? []).filter((image) => image.data);
    const files = (history[index].attachedFiles ?? []).filter((file) => file.data || file.text);
    if (!text.trim() && images.length === 0 && files.length === 0) return;
    const originalMessages = this.plugin.agent.exportMessages(Number.MAX_SAFE_INTEGER);
    const conversation = this.plugin.activeConversation;
    const originalTitle = conversation.title;
    const originalAutomaticTitle = conversation.automaticTitle;
    const originalTitleSource = conversation.titleSourceTurnId;
    const originalUpdatedAt = conversation.updatedAt;
    const originalNotes = conversation.notes ?? [];
    this.plugin.agent.cutBeforeTurn(turnId);
    this.plugin.chatHistory = history.slice(0, index);
    if (history[index].turnId === conversation.titleSourceTurnId) delete conversation.titleSourceTurnId;
    const replacementHistory = this.plugin.chatHistory;
    const rollback = () => {
      if (this.rollbackResend !== rollback) return;
      this.rollbackResend = undefined;
      this.plugin.agent.importMessages(originalMessages);
      this.plugin.chatHistory = history;
      conversation.title = originalTitle;
      conversation.automaticTitle = originalAutomaticTitle;
      conversation.titleSourceTurnId = originalTitleSource;
      conversation.updatedAt = originalUpdatedAt;
      if (originalNotes.length) conversation.notes = [...new Set([...originalNotes, ...conversation.notes ?? []])];
      // Preserve the rejection explanation alongside the original conversation.
      history.push(...replacementHistory.slice(index).filter(row => row.type === "error"));
      this.renderHistory();
      this.chatContainer?.setTitle(conversation.title);
      void this.plugin.saveChatHistory();
    };
    this.rollbackResend = rollback;
    this.chatContainer?.cutMessages(turnId);
    await this.handleUserMessage(text, selection, images, files, history[index].linkSource ?? "");
    if (this.rollbackResend === rollback) this.rollbackResend = undefined;
  }

  /** Until resend preflight succeeds, Stop/switch or rejection can restore the original turn. */
  private rollbackResend?: () => void;
  /** Restore synchronously on Stop, before an old async preflight can become stale. */
  private restorePendingDraft?: () => void;

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
    linkSource = this.plugin.app.workspace.getActiveFile()?.path ?? ""
  ): Promise<void> {
    if (this.running || this.undoing) {
      if (this.undoing) this.chatContainer?.restoreDraft?.(text, selection, images, files);
      new Notice("Please wait for the current response to complete.");
      return;
    }

    const chat = this.chatContainer;
    if (!chat) {
      // No UI (mounting it failed): nothing to show the turn in.
      new Notice("The chat panel couldn't be shown, so the message wasn't sent.");
      return;
    }
    const version = ++this.runVersion;
    const isCurrent = () => version === this.runVersion;
    const history = this.plugin.chatHistory;

    this.running = true;
    this.answerShown = false;
    // The screen stays on while the answer is generated.
    const releaseScreen = screenAwake.hold();
    this.releaseScreen = releaseScreen;
    const turnId = newTurnId();
    const savedSelection = selection ? historySelection(selection) : undefined;
    const conversation = this.plugin.activeConversation;
    chat.setInputEnabled(false);
    chat.setBusy(true);
    // What the model should know of (an undo), told once, with this turn.
    const notes = conversation.notes ?? [];
    delete conversation.notes;

    const toolCalls = new Map<string, { id: number; input: Record<string, unknown> }>();
    const changes = new ChangeLog();
    let started = false;
    let notesRestored = false;
    const restoreNotes = () => {
      if (!notesRestored && notes.length) conversation.notes = [...new Set([...notes, ...conversation.notes ?? []])];
      notesRestored = true;
    };
    const restorePendingDraft = () => {
      restoreNotes();
      chat.restoreDraft?.(text, selection, images, files);
    };
    this.restorePendingDraft = restorePendingDraft;

    try {
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
        history.push({ type: "error", text: budgetError });
        return;
      }
      // Only consume the submitted draft after its linked context is valid.
      // A rejected draft must not become an uneditable visible-only turn.
      chat.addUserMessage(text, images, turnId, savedSelection, files);
      history.push({ type: "user", text, images, turnId, linkSource, ...(savedSelection ? { selection: savedSelection } : {}), ...(files.length ? { attachedFiles: files } : {}) });
      this.plugin.touchConversation();
      chat.setTitle(conversation.title);
      started = true;
      this.restorePendingDraft = undefined;
      await this.plugin.agent.run(text, {
        changes,
        onPreflightRejected: (error) => {
          started = false;
          const pending = history.findIndex(row => row.type === "user" && row.turnId === turnId);
          if (pending !== -1) history.splice(pending);
          chat.cutMessages(turnId);
          this.plugin.touchConversation();
          chat.setTitle(conversation.title);
          chat.hideThinking();
          chat.addError(error);
          history.push({ type: "error", text: error });
        },
        onThinking: () => {
          chat.showThinking();
        },
        onToolCall: (name, input) => {
          this.rollbackResend = undefined;
          chat.hideThinking();
          if (name === "ask_user") return;
          // A tool step on screen shows that the turn did something.
          this.answerShown = true;
          toolCalls.set(name, { id: chat.addToolCall(name, input), input });
        },
        onToolResult: (name, { focus, ...result }: ToolResult) => {
          if (name === "ask_user") return;
          const call = toolCalls.get(name);
          if (call) chat.updateToolResult(call.id, name, result);
          history.push({ type: "tool-result", toolName: name, toolInput: savedToolInput(call?.input ?? {}), toolResult: result });
          const bounded = withoutLargeVisibleToolText(history);
          if (bounded !== history) for (let i = 0; i < history.length; i++) history[i] = bounded[i];
          if (focus && !result.isError && this.plugin.settings.followEdits) this.follow(focus);
        },
        onResponse: (text) => {
          this.rollbackResend = undefined;
          this.answerShown = true;
          chat.hideThinking();
          chat.addAssistantMessage(text);
          history.push({ type: "assistant", text });
        },
        onAskUser: async (question) => {
          this.rollbackResend = undefined;
          // The question is the answer so far.
          this.answerShown = true;
          chat.hideThinking();
          chat.setInputEnabled(true);
          // The chat shows the question and the typed answer; keep both in
          // the history so they are still there after a reload.
          history.push({ type: "assistant", text: question });
          const answer = await chat.showAskUser(question);
          // Empty: Stop or Clear dropped the question.
          if (!answer || !isCurrent()) return "";
          history.push({ type: "user", text: answer });
          chat.setInputEnabled(false);
          return answer;
        },
        onError: (error) => {
          chat.hideThinking();
          chat.addError(error);
          history.push({ type: "error", text: error });
        },
      }, selection, images, turnId, mentioned, notes, files);
    } catch (e) {
      if (!isCurrent()) return;
      if (this.rollbackResend) started = false;
      const msg = e instanceof Error ? e.message : String(e);
      chat.addError(`Unexpected error: ${msg}`);
      history.push({ type: "error", text: `Unexpected error: ${msg}` });
    } finally {
      if (this.restorePendingDraft === restorePendingDraft) this.restorePendingDraft = undefined;
      if (!started && isCurrent()) restoreNotes();
      if (!started && isCurrent()) this.rollbackResend?.();
      if (!started && isCurrent()) chat.restoreDraft?.(text, selection, images, files);
      releaseScreen();
      if (!changes.isEmpty()) this.addChanges(history, turnId, changes);
      // The turn is over: its steps fold into one row above the answer.
      chat.foldTurn(turnId);
      if (isCurrent()) {
        // The history's limit may have cut older turns off.
        this.updateEditable();
        this.running = false;
        if (!changes.isEmpty()) {
          for (const row of this.plugin.chatHistory) {
            if (row.type === "changes" && row.turnId && !row.undone && this.plugin.changeLogs.get(row)?.canUndo() === false) {
              chat.setChangesKept?.(row.turnId);
            }
          }
        }
        chat.setInputEnabled(true);
        chat.setBusy(false);
        chat.focus();
        // Persist after each turn
        void this.plugin.saveChatHistory();
      }
    }
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

  /** Stops the running turn; what it showed so far stays. */
  private stopTurn(): void {
    const restoreDraft = this.restorePendingDraft;
    this.restorePendingDraft = undefined;
    this.runVersion++;
    this.plugin.agent.abort();
    this.rollbackResend?.();
    // Resend rollback renders history, which clears attachment chips. Restore after it.
    restoreDraft?.();
    // A stopped request may still be waiting for its response.
    this.releaseScreen();
    this.running = false;
    // Otherwise the next message would answer the stopped turn's question.
    this.chatContainer?.cancelAskUser();
    this.chatContainer?.hideThinking();
  }

  private handleStop(): void {
    // Nothing of the answer is on screen yet: say that the turn was stopped.
    const silent = this.running && !this.answerShown;
    this.stopTurn();
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
    this.runVersion++;
    this.plugin.agent.clear();
    this.rollbackResend = undefined;
    this.restorePendingDraft = undefined;
    this.releaseScreen();
    this.plugin.chatHistory = [];
    delete this.plugin.activeConversation.notes;
    this.plugin.touchConversation();
    this.chatContainer?.setTitle(this.plugin.activeConversation.title);
    this.chatContainer?.clearMessages();
    this.chatContainer?.cancelAskUser();
    this.running = false;
    this.chatContainer?.setInputEnabled(true);
    this.chatContainer?.setBusy(false);
    // Clear persisted state
    void this.plugin.saveChatHistory();
  }
}
