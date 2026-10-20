<script lang="ts">
  import type { App, TFile } from "obsidian";
  import { Component as ObsidianComponent, MarkdownRenderer, Notice } from "obsidian";
  import { tick, onDestroy } from "svelte";
  import type { ToolResult, SelectionScope, ImageAttachment, FileAttachment, ConversationSummary, ChatErrorKind } from "../types";
  import { ACCEPTED_FILES, MAX_FILE_BYTES, fileAttachment, attachmentBudgetError } from "../files/attachments";
  import { formatBytes } from "../images";
  import { LARGE_CHAT_BYTES } from "../chat-state";
  import { insertMention, mentionAt, mentionCandidates, type MentionQuery } from "./mentions";
  import { skillAt, skillCandidates, type Skill } from "../agent/skills";
  import { normalizeMathMarkdown } from "./math-markdown";
  import { isSendKey } from "./send-key";
  import { fileLabel, toolLabel } from "./tool-label";
  import { foldPlan } from "./fold-turn";
  import type { ChangesState, UsageView, VoiceAction } from "./chat-view";
  import type { VoiceViewState } from "../voice/controller";
  import { AttachmentPreparation } from "./attachment-preparation";
  import { withoutLargeVisibleToolText } from "../agent/history";
  import { formatCost, formatTokens } from "../agent/usage";

  /** Where a ChatGPT account sees its plan's Codex usage. */
  const CHATGPT_USAGE_URL = "https://chatgpt.com/codex/settings/usage";


  const MAX_IMAGE_COUNT = 4;
  const MAX_FILE_COUNT = 4;
  const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
  const MAX_TOTAL_IMAGE_BYTES = 12 * 1024 * 1024;
  const SUPPORTED_IMAGE_TYPES = new Set([
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
  ]);

  interface ChatMessage {
    id: number;
    type: "user" | "assistant" | "tool-call" | "tool-result" | "error" | "thinking" | "changes" | "steps";
    text?: string;
    images?: ImageAttachment[];
    /** User messages: attached files (PDF, Office, text). */
    attached?: FileAttachment[];
    toolName?: string;
    toolInput?: Record<string, unknown>;
    toolResult?: ToolResult;
    /** User messages of a turn (not `ask_user` answers): editable. Changes rows: their turn. */
    turnId?: string;
    selection?: SelectionScope;
    /** Assistant messages: text still arriving (no actions yet). */
    streaming?: boolean;
    errorKind?: ChatErrorKind;
    /** Changes rows: the files a turn changed, and whether it can be undone. */
    files?: string[];
    changesState?: ChangesState;
    /** Changes rows: opened into the list of files. */
    changesOpen?: boolean;
    /** Steps rows (a finished turn's work, folded): its tool steps and the texts that led into them. */
    steps?: ChatMessage[];
    /** Steps rows: opened into the steps and files. */
    stepsOpen?: boolean;
    /** Tool steps: opened into their parameters and result (built only then). */
    toolOpen?: boolean;
  }

  interface Props {
    app: App;
    component: ObsidianComponent;
    provider: string;
    model: string;
    onSend: (text: string, selection: SelectionScope | null, images: ImageAttachment[], files: FileAttachment[]) => void;
    onClear: () => void;
    onStop: () => void;
    onEdit: (turnId: string, text: string) => void;
    onRegenerate: () => void;
    onCopy: (text: string) => void;
    /** The current conversation's title. */
    title: string;
    onNewChat: () => void;
    listConversations: () => ConversationSummary[];
    onOpenConversation: (id: string) => void;
    onRenameConversation: (id: string, title: string) => void;
    onDeleteConversation: (id: string) => void;
    /** The eye button: follow the AI's edits on or off. */
    onToggleFollow: () => void;
    /** Undo the vault changes of turn `turnId`. */
    onUndo: (turnId: string) => void;
    /** The vault's skills, offered after `/`. */
    listSkills: () => Skill[];
    /** Continue the turn that was cut off when Obsidian was ended. */
    onContinue: () => void;
    /** Summarize the chat now (the context ring's details). */
    onCompact: () => void;
    /** Show the turns before the shown ones (scrolled near the top). */
    onLoadEarlier: () => void;
    /** The voice button and the voice bar's controls. */
    onVoice: (action: VoiceAction) => void;
  }

  let {
    app, component, provider, model, onSend, onClear, onStop, onEdit, onRegenerate, onCopy,
    title, onNewChat, listConversations, onOpenConversation, onRenameConversation, onDeleteConversation,
    onToggleFollow, onUndo, listSkills, onContinue, onCompact, onLoadEarlier, onVoice,
  }: Props = $props();

  // ─── Context ring ─────────────────────────────────────────────────────
  let usage = $state<UsageView | null>(null);
  let usageOpen = $state(false);
  let usageEl: HTMLElement | undefined = $state();

  export function setUsage(next: UsageView | null): void {
    usage = next;
    if (!next) usageOpen = false;
  }

  /** The details close on a click elsewhere or Escape. */
  function closeUsageOutside(event: MouseEvent): void {
    if (usageOpen && usageEl && event.target instanceof Node && !usageEl.contains(event.target)) usageOpen = false;
  }

  /** A turn was cut off when Obsidian was ended in the background: offer Continue. */
  let canContinue = $state(false);

  export function setContinue(show: boolean): void {
    canContinue = show;
  }

  function continueTurn(): void {
    canContinue = false;
    onContinue();
  }

  // ─── Voice ─────────────────────────────────────────────────────────────
  /** Signed in to ChatGPT: offer the voice button. */
  let canVoice = $state(false);
  let voice = $state<VoiceViewState | null>(null);

  const VOICE_STATUS: Record<VoiceViewState["status"], string> = {
    connecting: "Connecting…",
    reconnecting: "Reconnecting…",
    listening: "Listening",
    thinking: "Working on it…",
    speaking: "Speaking",
  };

  /** The end of a long caption line. */
  function captionTail(text: string, max = 80): string {
    const trimmed = text.trim();
    return trimmed.length > max ? `…${trimmed.slice(-max)}` : trimmed;
  }

  /** The voice bar's one line: the user's words while they speak, else the state. */
  function voiceLine(state: VoiceViewState): string {
    if (state.you && (state.status === "listening" || state.status === "thinking")) return captionTail(state.you);
    if (state.status === "listening" && !state.micOn) return state.holdToTalk ? "Hold the microphone to talk" : "Microphone off";
    return VOICE_STATUS[state.status];
  }

  /** Hold to talk: the microphone is on while the button is pressed. */
  function talkStart(event: PointerEvent): void {
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    onVoice("talk-start");
  }

  function talkKey(event: KeyboardEvent, pressed: boolean): void {
    if (event.key !== " " && event.key !== "Enter") return;
    event.preventDefault();
    if (event.repeat) return;
    onVoice(pressed ? "talk-start" : "talk-end");
  }

  /** Show the voice bar (null hides it). */
  export function setVoice(state: VoiceViewState | null): void {
    voice = state;
  }

  export function setVoiceAvailable(available: boolean): void {
    canVoice = available;
  }

  let displayModel = $state("");
  let displayTitle = $state("");

  // ─── History list (a drawer over the chat) ────────────────────────────
  let historyOpen = $state(false);
  let conversations = $state<ConversationSummary[]>([]);
  let renamingId = $state<string | null>(null);
  let renameText = $state("");
  let deletingId = $state<string | null>(null);

  // Sync title prop to local state (also updateable via setTitle)
  $effect(() => {
    displayTitle = title;
  });

  function refreshConversations(): void {
    conversations = listConversations();
  }

  /** The open chats list again (a chat started or finished answering in the background). */
  export function updateConversations(): void {
    if (historyOpen) refreshConversations();
  }

  function toggleHistory(): void {
    historyOpen = !historyOpen;
    renamingId = null;
    deletingId = null;
    if (historyOpen) refreshConversations();
  }

  function closeHistory(): void {
    historyOpen = false;
    renamingId = null;
    deletingId = null;
  }

  function newChat(): void {
    closeHistory();
    onNewChat();
  }

  function openConversation(id: string): void {
    closeHistory();
    onOpenConversation(id);
  }

  function startRename(conversation: ConversationSummary): void {
    deletingId = null;
    renamingId = conversation.id;
    renameText = conversation.title;
  }

  /** Saves the name being edited (Enter, or leaving the field). */
  function saveRename(id: string): void {
    if (renamingId !== id) return;
    renamingId = null;
    onRenameConversation(id, renameText);
    refreshConversations();
  }

  function handleRenameKeydown(e: KeyboardEvent, id: string): void {
    if (e.isComposing || e.keyCode === 229) return;
    if (e.key === "Enter") {
      e.preventDefault();
      saveRename(id);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      renamingId = null;
    }
  }

  function confirmDelete(id: string): void {
    deletingId = null;
    onDeleteConversation(id);
    refreshConversations();
  }

  function handleHistoryKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.preventDefault();
      closeHistory();
    }
  }

  /** The rename field: focused with its text selected. */
  function renameBox(node: HTMLInputElement) {
    node.focus();
    node.select();
  }

  /** Time today, otherwise the date. */
  function formatDate(time: number): string {
    if (!time) return "";
    const date = new Date(time);
    return date.toDateString() === new Date().toDateString()
      ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
      : date.toLocaleDateString();
  }
  let messages = $state<ChatMessage[]>([]);
  let inputText = $state("");
  let inputEnabled = $state(true);
  let messagesEl: HTMLElement | undefined = $state();
  let textareaEl: HTMLTextAreaElement | undefined = $state();
  let fileInputEl: HTMLInputElement | undefined = $state();
  let attachments = $state<ImageAttachment[]>([]);
  /** Attached PDF, Office and text files. */
  let fileAttachments = $state<FileAttachment[]>([]);
  // The input shows a scrollbar only once its text is taller than it can grow.
  let inputScrollable = $state(false);
  let nextId = 0;
  /** A turn is running (set by the view); regenerate waits for it. */
  let busy = $state(false);
  let composerLocked = $state(false);
  let attachmentLoading = $state(false);
  const attachmentPreparation = new AttachmentPreparation(loading => { attachmentLoading = loading; });
  onDestroy(() => attachmentPreparation.cancel());

  // Editing a user message in place
  let editingId = $state<number | null>(null);
  let editText = $state("");

  /** The last answer (no user turn after it): the one that can be regenerated. */
  const lastAnswerId = $derived.by(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === "assistant") return msg.id;
      if (msg.type === "user" && msg.turnId) return -1;
    }
    return -1;
  });

  /** The turn of the last answer. */
  const lastTurnId = $derived([...messages].reverse().find((msg) => msg.type === "user" && !!msg.turnId)?.turnId);

  /** Which turns can be edited or answered again: those the API history still holds. Set by the view. */
  let editable = $state<(turnId: string) => boolean>(() => true);

  export function setEditable(check: (turnId: string) => boolean): void {
    editable = check;
  }

  // Selection scope (shown as a pill above input)
  let selection = $state<SelectionScope | null>(null);

  // ask_user support
  let askUserResolve: ((value: string) => void) | null = $state(null);

  /** The action slot shows voice while there is nothing to send (not while a question waits for its answer). */
  const showVoiceStart = $derived(
    canVoice && !voice && !askUserResolve && inputText.trim() === "" && attachments.length === 0 && fileAttachments.length === 0,
  );

  // Sync model prop to local state (also updateable via setModel)
  $effect(() => {
    displayModel = model;
  });

  // ─── Scrolling: stick to the bottom, like a chat ──────────────────────
  // While the user is at the bottom, new messages and a streaming answer
  // keep the view there. Scrolling up stops that, so earlier messages can
  // be read while a turn runs; back at the bottom it follows again. Sending
  // a question always brings the view down. While scrolled up, a button
  // jumps back to the bottom. Only scrolling up stops following: the
  // browser also scrolls by itself (content above changing height, a
  // shorter list), which mustn't leave the answer half hidden.
  /** Pixels from the bottom that still count as "at the bottom". */
  const BOTTOM_SLACK = 32;
  let messageListEl: HTMLElement | undefined = $state();
  let stickToBottom = true;
  /**
   * Scrolled up from the bottom: the browser keeps the view on what it shows
   * when rows above change height (scroll anchoring: earlier turns coming
   * in, rows laid out late). Off while following the bottom.
   */
  let readingBack = $state(false);
  let showJump = $state(false);
  let lastQuestionId = -1;
  let lastScrollTop = 0;

  function isAtBottom(el: HTMLElement): boolean {
    return el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_SLACK;
  }

  /** Follow new content while sticking to the bottom; otherwise offer the jump button. */
  function followBottom(): void {
    const el = messagesEl;
    if (!el) return;
    if (stickToBottom) {
      el.scrollTop = el.scrollHeight;
      lastScrollTop = el.scrollTop;
      showJump = false;
    } else if (!isAtBottom(el)) {
      showJump = true;
    }
  }

  function jumpToBottom(): void {
    stickToBottom = true;
    readingBack = false;
    followBottom();
  }

  // ─── Earlier turns ────────────────────────────────────────────────────
  // The view shows a chat's last turns; scrolled near the top, or when they
  // don't fill the view, the turns before them come in above, and the view
  // stays where it was (Safari doesn't keep it by itself).
  /** Pixels from the top at which the earlier turns load. */
  const EARLIER_SLACK = 400;
  let hasEarlier = false;

  /** Whether the chat has turns before the shown ones (set by the view). */
  export function setHasEarlier(value: boolean): void {
    hasEarlier = value;
    if (value) void tick().then(loadEarlierIfNear);
  }

  function loadEarlierIfNear(): void {
    const el = messagesEl;
    // A hidden chat (a background tab) has no height: it would load every turn.
    if (hasEarlier && el && el.clientHeight > 0 && el.scrollTop < EARLIER_SLACK) onLoadEarlier();
  }

  /**
   * Rows from an earlier part of the chat: `fill` adds them as it would at
   * the end; they go above the shown ones, and the view keeps its place.
   */
  export function prependMessages(fill: () => void): void {
    const shown = messages;
    const el = messagesEl;
    const fromBottom = el ? el.scrollHeight - el.scrollTop : 0;
    messages = [];
    try {
      fill();
    } finally {
      messages = [...messages, ...shown];
    }
    void tick().then(() => {
      if (!el) return;
      el.scrollTop = el.scrollHeight - fromBottom;
      lastScrollTop = el.scrollTop;
    });
  }

  // A new question (sent, or the history shown anew) brings the view down.
  $effect(() => {
    let lastId = -1;
    for (const msg of messages) if (msg.type === "user") lastId = msg.id;
    if (lastId !== lastQuestionId) {
      lastQuestionId = lastId;
      stickToBottom = true;
      readingBack = false;
    }
    followBottom();
  });

  // Rendered Markdown, math, images, opened tool details and a resized panel
  // or phone keyboard change heights after the messages do.
  $effect(() => {
    const el = messagesEl;
    if (!el || !messageListEl) return;
    // Shown after being hidden, the chat may need its earlier turns too.
    const observer = new ResizeObserver(() => {
      followBottom();
      loadEarlierIfNear();
    });
    observer.observe(el, { box: "border-box" });
    observer.observe(messageListEl);
    // Scrolling up (wheel, touch, scrollbar, keys) stops following; back at the bottom it follows.
    const onScroll = () => {
      if (isAtBottom(el)) stickToBottom = true;
      else if (el.scrollTop < lastScrollTop) stickToBottom = false;
      lastScrollTop = el.scrollTop;
      showJump = !stickToBottom && !isAtBottom(el);
      readingBack = !stickToBottom;
      loadEarlierIfNear();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      el.removeEventListener("scroll", onScroll);
    };
  });

  // ─── Public API (called from chat-view.ts / chat-modal.ts) ────────────

  export function addUserMessage(
    text: string,
    images: ImageAttachment[] = [],
    turnId?: string,
    selection?: SelectionScope,
    files: FileAttachment[] = [],
  ): void {
    messages.push({ id: nextId++, type: "user", text, images: images.slice(), attached: files.slice(), turnId, selection });
  }

  /** Restore inputs if linked context fails validation before a turn starts. */
  export function restoreDraft(text: string, currentSelection: SelectionScope | null, images: ImageAttachment[], files: FileAttachment[]): void {
    attachmentPreparation.cancel();
    inputText = text;
    selection = currentSelection;
    attachments = images.slice();
    fileAttachments = files.slice();
    void tick().then(autoGrow);
  }

  export function addAssistantMessage(text: string, streaming = false): number {
    const id = nextId++;
    messages.push({ id, type: "assistant", text, streaming });
    return id;
  }

  // ─── Streamed answers: Markdown is re-rendered at most every 100 ms ────
  const STREAM_RENDER_MS = 100;
  const pendingText = new Map<number, string>();
  let renderTimer: number | null = null;
  onDestroy(() => {
    if (renderTimer !== null) window.clearTimeout(renderTimer);
  });

  /** Replace an assistant message's text; `final` renders it at once and ends its streaming. */
  export function updateAssistantMessage(id: number, text: string, final = false): void {
    pendingText.set(id, text);
    if (final) {
      flushPendingText();
      const msg = messages.find((m) => m.id === id);
      if (msg) msg.streaming = false;
    } else {
      renderTimer ??= window.setTimeout(flushPendingText, STREAM_RENDER_MS);
    }
  }

  function flushPendingText(): void {
    if (renderTimer !== null) window.clearTimeout(renderTimer);
    renderTimer = null;
    for (const [id, text] of pendingText) {
      const msg = messages.find((m) => m.id === id);
      if (msg) msg.text = text;
    }
    pendingText.clear();
  }

  export function removeMessage(id: number): void {
    pendingText.delete(id);
    const idx = messages.findIndex((m) => m.id === id);
    if (idx !== -1) messages.splice(idx, 1);
  }

  /** Remove the turn `turnId` and everything after it (edit, regenerate). */
  export function cutMessages(turnId: string): void {
    const idx = messages.findIndex((m) => m.type === "user" && m.turnId === turnId);
    if (idx === -1) return;
    for (const msg of messages.slice(idx)) pendingText.delete(msg.id);
    messages.splice(idx);
    editingId = null;
  }

  export function addToolCall(name: string, input: Record<string, unknown>): number {
    const id = nextId++;
    messages.push({ id, type: "tool-call", toolName: name, toolInput: input });
    return id;
  }

  export function updateToolResult(msgId: number, name: string, result: ToolResult): void {
    const msg = messages.find((m) => m.id === msgId);
    if (msg) {
      msg.type = "tool-result";
      msg.toolName = name;
      msg.toolResult = result;
      messages = withoutLargeVisibleToolText(messages);
    }
  }

  /** The thinking dots, with a short label such as "Resuming…" (none: just the dots). */
  export function showThinking(label = ""): void {
    const shown = messages.find((m) => m.type === "thinking");
    if (shown) shown.text = label;
    else messages.push({ id: nextId++, type: "thinking", text: label });
  }

  export function hideThinking(): void {
    const idx = messages.findIndex((m) => m.type === "thinking");
    if (idx !== -1) messages.splice(idx, 1);
  }

  export function addError(text: string, errorKind?: ChatErrorKind): void {
    messages.push({ id: nextId++, type: "error", text, errorKind });
  }

  /**
   * The row of files a turn changed: right after the turn's last tool step,
   * before the answer that reports the change (at the end without one).
   */
  export function addChanges(turnId: string, files: string[], state: ChangesState): void {
    const row: ChatMessage = { id: nextId++, type: "changes", turnId, files, changesState: state };
    const start = messages.findIndex((m) => m.type === "user" && m.turnId === turnId);
    const later = messages.findIndex((m, i) => i > start && m.type === "user" && !!m.turnId && m.turnId !== turnId);
    const end = later === -1 ? messages.length : later;
    let at = end;
    for (let i = end - 1; i > start; i--) {
      // A step is a tool-call while it runs and a tool-result once done.
      if (messages[i].type === "tool-call" || messages[i].type === "tool-result") {
        at = i + 1;
        break;
      }
    }
    messages.splice(at, 0, row);
  }

  export function setChangesUndone(turnId: string): void {
    const row = messages.find((m) => (m.type === "changes" || m.type === "steps") && m.turnId === turnId);
    if (row) row.changesState = "undone";
  }

  export function setChangesKept(turnId: string): void {
    const row = messages.find((m) => (m.type === "changes" || m.type === "steps") && m.turnId === turnId);
    if (row) row.changesState = "kept";
  }

  /** A finished turn's work folds into one row right above its answer (`foldPlan`). */
  export function foldTurn(turnId: string): void {
    const plan = foldPlan(messages, turnId);
    if (!plan) return;
    const { at, steps, changes } = plan;
    const gone = new Set<ChatMessage>(changes ? [...steps, changes] : steps);
    const row: ChatMessage = {
      id: nextId++, type: "steps", turnId, steps,
      ...(changes ? { files: changes.files, changesState: changes.changesState } : {}),
    };
    const kept = (m: ChatMessage) => !gone.has(m);
    messages = [...messages.slice(0, at).filter(kept), row, ...messages.slice(at).filter(kept)];
  }

  /** A steps row's label: what changed, or how many steps it folds. */
  function stepsLabel(msg: ChatMessage): string {
    const count = (msg.steps ?? []).filter((m) => m.type === "tool-call" || m.type === "tool-result").length;
    const steps = count === 1 ? "1 step" : `${count} steps`;
    const files = msg.files ?? [];
    if (!files.length) return steps;
    const verb = msg.changesState === "undone" ? "Undid the changes to" : "Changed";
    return `${verb} ${files.map(fileLabel).join(", ")} · ${steps}`;
  }

  /** Open a changed file (one that no longer exists is left alone). */
  function openChanged(path: string): void {
    const file = app.vault.getFileByPath(path);
    if (file) void app.workspace.getLeaf(false).openFile(file);
  }

  /**
   * The next input answers an `ask_user` question. `question` is shown as
   * the AI's message; without it the chat already shows it (back in the
   * chat whose question waited).
   */
  export function showAskUser(question?: string): Promise<string> {
    if (question !== undefined) addAssistantMessage(question);
    inputEnabled = true;
    textareaEl?.focus();

    return new Promise<string>((resolve) => {
      askUserResolve = resolve;
    });
  }

  /** Drop a pending ask_user question (its turn was stopped or cleared). */
  export function cancelAskUser(): void {
    const resolve = askUserResolve;
    askUserResolve = null;
    resolve?.("");
  }

  export function setInputEnabled(enabled: boolean, preservePreparation = false): void {
    if (!enabled && !preservePreparation) attachmentPreparation.cancel();
    inputEnabled = enabled;
  }

  export function setBusy(value: boolean): void {
    busy = value;
  }

  export function setComposerLocked(value: boolean): void {
    composerLocked = value;
  }

  export function setRetainedAttachments(entries: import("../types").ChatHistoryEntry[]): void {
    const users = new Map(entries.filter(entry => entry.type === "user" && entry.turnId).map(entry => [entry.turnId, entry]));
    for (const message of messages) {
      const entry = message.turnId ? users.get(message.turnId) : undefined;
      if (message.type !== "user" || !entry) continue;
      message.images = entry.images;
      message.attached = entry.attachedFiles;
    }
  }

  /** Messages sent while the answer runs, until the agent takes them in (or they run next). */
  let queued = $state<string[]>([]);

  export function setQueued(texts: string[]): void {
    queued = texts;
  }

  export function clearMessages(preserveDraft = false): void {
    pendingText.clear();
    messages = [];
    editingId = null;
    if (!preserveDraft) {
      attachmentPreparation.cancel();
      attachments = [];
      fileAttachments = [];
      if (fileInputEl) fileInputEl.value = "";
      selection = null;
    }
    hideThinking();
  }

  export function focus(): void {
    textareaEl?.focus();
  }

  /** Update the model display name in the header */
  export function setModel(name: string): void {
    displayModel = name;
  }

  /** Update the conversation title in the header */
  export function setTitle(value: string): void {
    displayTitle = value;
  }

  /** Set the selection scope (shows pill in UI) */
  export function setSelection(sel: SelectionScope): void {
    selection = sel;
  }

  /** Get the current selection scope */
  export function getSelection(): SelectionScope | null {
    return selection;
  }

  /** Clear the selection scope */
  export function clearSelection(): void {
    selection = null;
  }

  /** On: Enter sends, Shift+Enter is a new line. Off: Enter is a new line, Ctrl/Cmd+Enter sends. */
  let enterSends = $state(true);

  export function setEnterSends(on: boolean): void {
    enterSends = on;
  }

  /** "Follow the AI's edits": the eye button shows the setting. */
  let followEdits = $state(true);

  export function setFollowEdits(on: boolean): void {
    followEdits = on;
  }

  // ─── Internal handlers ────────────────────────────────────────────────

  /** Ctrl/Cmd+Enter, which Obsidian keeps from the input (see chat-view.ts). */
  export function sendFromKeyboard(target: EventTarget | null): boolean {
    if (!target) return false;
    if (target === textareaEl) {
      handleSend();
      return true;
    }
    // The edit box of a sent message saves with the same key.
    const editing = editingId === null ? undefined : messages.find((m) => m.id === editingId);
    if (editing && target instanceof HTMLElement && target.closest(".ochatting-user-edit")) {
      saveEdit(editing);
      return true;
    }
    return false;
  }

  function handleSend(): void {
    if (!inputEnabled || attachmentLoading || composerLocked) return;
    const text = inputText.trim();
    if (!text && attachments.length === 0 && fileAttachments.length === 0) return;

    if (askUserResolve && (attachments.length > 0 || fileAttachments.length > 0)) {
      new Notice("Attachments are not supported when answering a tool question.");
      return;
    }
    if (busy && !askUserResolve) {
      // Added to the running turn (the view steers it); attachments and the
      // selection stay for the next message.
      if (!text) return;
      inputText = "";
      resetHeight();
      onSend(text, null, [], []);
      return;
    }

    inputText = "";
    resetHeight();
    const sentImages = attachments.slice();
    const sentFiles = fileAttachments.slice();
    attachments = [];
    fileAttachments = [];

    if (askUserResolve) {
      addUserMessage(text);
      const resolve = askUserResolve;
      askUserResolve = null;
      resolve(text);
      return;
    }

    // Pass current selection and consume it (one-shot per send)
    const currentSelection = selection;
    selection = null;
    onSend(text, currentSelection, sentImages, sentFiles);
  }

  // ─── Mentions (`@` or `[[`: link a vault file; its content goes along) ──
  // and skills (`/name`: the skill goes along), in one list.
  type Suggestion = { kind: "file"; file: TFile } | { kind: "skill"; skill: Skill };
  let mention = $state<MentionQuery | null>(null);
  let mentionItems = $state<Suggestion[]>([]);
  let mentionIndex = $state(0);

  /** Offer skills or files for what the caret is in (none: the list closes). */
  function updateMention(): void {
    const caret = textareaEl?.selectionStart ?? 0;
    const command = textareaEl ? skillAt(inputText, caret) : null;
    const skills = command ? skillCandidates(listSkills(), command.query) : [];
    const found = skills.length ? command : textareaEl ? mentionAt(inputText, caret) : null;
    mentionItems = skills.length
      ? skills.map((skill) => ({ kind: "skill", skill }))
      : found ? mentionCandidates(app, found.query).map((file) => ({ kind: "file", file })) : [];
    mention = mentionItems.length ? found : null;
    mentionIndex = 0;
  }

  function closeMention(): void {
    mention = null;
    mentionItems = [];
  }

  function chooseMention(item: Suggestion): void {
    if (!mention || !textareaEl) return;
    const caret = textareaEl.selectionStart;
    const source = app.workspace.getActiveFile()?.path ?? "";
    const next = item.kind === "file"
      ? insertMention(app, inputText, mention, caret, item.file, source)
      : { text: `${inputText.slice(0, mention.start)}/${item.skill.name} ${inputText.slice(caret).replace(/^ /, "")}`, caret: mention.start + item.skill.name.length + 2 };
    inputText = next.text;
    closeMention();
    const el = textareaEl;
    void tick().then(() => {
      el.focus();
      el.setSelectionRange(next.caret, next.caret);
      autoGrow();
    });
  }

  /** The list's keys: arrows move, Enter or Tab choose, Escape closes. True when handled. */
  function mentionKey(e: KeyboardEvent): boolean {
    if (!mention || mentionItems.length === 0 || e.isComposing) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const step = e.key === "ArrowDown" ? 1 : -1;
      mentionIndex = (mentionIndex + step + mentionItems.length) % mentionItems.length;
    } else if ((e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
      chooseMention(mentionItems[mentionIndex]);
    } else if (e.key === "Escape") {
      closeMention();
    } else {
      return false;
    }
    e.preventDefault();
    e.stopPropagation();
    return true;
  }

  /** The folder a candidate is in, shown after its name. */
  function folderOf(file: TFile): string {
    return file.parent && !file.parent.isRoot() ? file.parent.path : "";
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (mentionKey(e)) return;
    if (e.isComposing || e.keyCode === 229) return;
    if (isSendKey(e, enterSends)) {
      e.preventDefault();
      handleSend();
    }
  }

  function startEdit(msg: ChatMessage): void {
    editingId = msg.id;
    editText = msg.text ?? "";
  }

  function saveEdit(msg: ChatMessage): void {
    const text = editText.trim();
    // Images and files no longer saved aren't sent again (chat-view.ts editMessage).
    if (!msg.turnId || (!text && !msg.images?.some((image) => image.data) && !msg.attached?.some((file) => file.data || file.text))) return;
    editingId = null;
    onEdit(msg.turnId, text);
  }

  function handleEditKeydown(e: KeyboardEvent, msg: ChatMessage): void {
    if (e.isComposing || e.keyCode === 229) return;
    // Saves with the same keys that send a message.
    if (isSendKey(e, enterSends)) {
      e.preventDefault();
      saveEdit(msg);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      editingId = null;
    }
  }

  /** The edit box: focused with the cursor at the end, grows with its text. */
  function editBox(node: HTMLTextAreaElement) {
    const grow = () => {
      node.style.height = "auto";
      node.style.height = Math.min(node.scrollHeight, 300) + "px";
    };
    node.addEventListener("input", grow);
    grow();
    node.focus();
    node.setSelectionRange(node.value.length, node.value.length);
    return {
      destroy() {
        node.removeEventListener("input", grow);
      },
    };
  }

  function autoGrow(): void {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
    textareaEl.style.height = Math.min(textareaEl.scrollHeight, 300) + "px";
    inputScrollable = textareaEl.scrollHeight > 300;
  }

  function resetHeight(): void {
    if (!textareaEl) return;
    textareaEl.style.height = "auto";
    inputScrollable = false;
  }

  function imageDataUrl(image: ImageAttachment): string {
    return `data:${image.mediaType};base64,${image.data}`;
  }

  function openImagePicker(): void {
    if (inputEnabled && !attachmentLoading) fileInputEl?.click();
  }

  async function handleImageSelection(event: Event): Promise<void> {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    const files = Array.from(input.files ?? []);
    input.value = "";
    await addFiles(files);
  }

  function handlePaste(event: ClipboardEvent): void {
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    event.preventDefault();
    void addFiles(files);
  }

  /** Images to the images, everything else as a file (PDF, Office, text). */
  async function addFiles(files: File[]): Promise<void> {
    if (!inputEnabled || attachmentLoading) {
      new Notice("Please wait for the current attachments or response to finish.");
      return;
    }
    const preparation = attachmentPreparation.begin();
    try {
      // By type, or by name when the picker gives no type.
      const isImage = (file: File) => file.type.startsWith("image/") || inferImageMimeType(file.name) !== "";
      await addImageFiles(files.filter(isImage), preparation.current);
      if (!preparation.current()) return;
      for (const file of files.filter((file) => !isImage(file))) {
        if (fileAttachments.length >= MAX_FILE_COUNT) {
          new Notice(`Attach up to ${MAX_FILE_COUNT} files per message.`);
          return;
        }
        if (file.size > MAX_FILE_BYTES) {
          new Notice(`${file.name} exceeds the 10 MB file limit.`);
          continue;
        }
        const bytes = await file.arrayBuffer();
        if (!preparation.current()) return;
        const attachment = await fileAttachment(file.name, bytes);
        if (!preparation.current()) return;
        if (typeof attachment === "string") new Notice(attachment);
        else {
          const error = attachmentBudgetError(attachments, [...fileAttachments, attachment]);
          if (error) new Notice(error);
          else fileAttachments = [...fileAttachments, attachment];
        }
      }
    } catch (error) {
      preparation.commit(() => new Notice(`Could not attach file: ${error instanceof Error ? error.message : String(error)}`));
    } finally { preparation.finish(); }
  }

  function removeFile(id: string): void {
    fileAttachments = fileAttachments.filter((file) => file.id !== id);
  }

  async function addImageFiles(files: File[], current: () => boolean): Promise<void> {
    for (const file of files) {
      if (attachments.length >= MAX_IMAGE_COUNT) {
        new Notice(`Attach up to ${MAX_IMAGE_COUNT} images per message.`);
        return;
      }

      try {
        const image = await readImageAttachment(file);
        if (!current()) return;
        const budgetError = attachmentBudgetError([...attachments, image], fileAttachments);
        if (budgetError) {
          new Notice(budgetError);
          return;
        }
        const currentBytes = attachments.reduce((total, item) => total + item.sizeBytes, 0);
        if (currentBytes + image.sizeBytes > MAX_TOTAL_IMAGE_BYTES) {
          new Notice("The combined image size must be 12 MB or less per message.");
          return;
        }
        attachments = [...attachments, image];
      } catch (error) {
        if (!current()) return;
        const message = error instanceof Error ? error.message : String(error);
        new Notice(`Could not attach ${file.name || "image"}: ${message}`);
      }
    }
  }

  async function readImageAttachment(file: File): Promise<ImageAttachment> {
    let mediaType = file.type.toLowerCase() || inferImageMimeType(file.name);
    const isHeic = mediaType === "image/heic" || mediaType === "image/heif" ||
      /\.(heic|heif)$/i.test(file.name);
    let source: Blob = file;

    if (mediaType === "image/svg+xml") {
      throw new Error("SVG images are not supported. Choose a raster image instead.");
    }
    if (!mediaType.startsWith("image/")) {
      throw new Error("Choose an image file.");
    }

    if (isHeic || !SUPPORTED_IMAGE_TYPES.has(mediaType) || file.size > MAX_IMAGE_BYTES) {
      if (mediaType === "image/gif") {
        throw new Error("GIF files must be 5 MB or smaller.");
      }
      try {
        const bitmap = await createImageBitmap(file);
        const scale = Math.min(1, 2048 / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Image conversion is unavailable.");
        context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        bitmap.close();
        mediaType = mediaType === "image/png" ? "image/png" : "image/jpeg";
        source = await new Promise<Blob>((resolve, reject) => {
          canvas.toBlob(
            (blob) => blob ? resolve(blob) : reject(new Error("Image conversion failed.")),
            mediaType,
            0.85,
          );
        });
      } catch {
        throw new Error("This image could not be converted. Try JPEG or PNG instead.");
      }
    }

    if (!SUPPORTED_IMAGE_TYPES.has(mediaType)) {
      throw new Error("Use a JPEG, PNG, GIF, or WebP image.");
    }
    if (source.size > MAX_IMAGE_BYTES) {
      throw new Error("Images must be 5 MB or smaller after conversion.");
    }

    const dataUrl = await readAsDataUrl(source);
    const comma = dataUrl.indexOf(",");
    if (comma < 0) throw new Error("Image could not be read.");
    return {
      id: `image-${Date.now()}-${nextId++}`,
      fileName: file.name || `image.${mediaType.split("/")[1]}`,
      mediaType,
      data: dataUrl.slice(comma + 1),
      sizeBytes: source.size,
    };
  }

  function inferImageMimeType(fileName: string): string {
    const extension = fileName.split(".").pop()?.toLowerCase();
    const types: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
      heic: "image/heic",
      heif: "image/heif",
    };
    return extension ? types[extension] ?? "" : "";
  }

  function readAsDataUrl(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("Image could not be read."));
      reader.onerror = () => reject(new Error("Image could not be read."));
      reader.readAsDataURL(blob);
    });
  }

  function removeAttachment(id: string): void {
    attachments = attachments.filter((image) => image.id !== id);
  }

  // Render markdown into a DOM node using Obsidian's renderer. Each render
  // gets its own child component, unloaded when the text changes or the
  // message goes away; with the view itself as the component, everything
  // the renderer registers would stay loaded until the view closes. Math
  // delimiters are normalized for display only; the message stays unchanged.
  function markdown(node: HTMLElement, text: string) {
    let child: ObsidianComponent | null = null;
    const render = (value: string) => {
      if (child) component.removeChild(child);
      child = component.addChild(new ObsidianComponent());
      node.empty();
      MarkdownRenderer.render(app, normalizeMathMarkdown(value), node, "", child);
    };
    render(text);
    return {
      update: render,
      destroy() {
        if (child) component.removeChild(child);
      },
    };
  }

  function truncate(str: string, max: number): string {
    if (str.length <= max) return str;
    return str.substring(0, max) + "\n... (truncated)";
  }
</script>

<!-- A user message's images; one no longer saved shows as a chip with its name. -->
{#snippet userImages(images: ImageAttachment[])}
  <div class="ochatting-user-images">
    {#each images as image (image.id)}
      {#if image.data}
        <img src={imageDataUrl(image)} alt={image.fileName} />
      {:else}
        <span class="ochatting-image-chip" title="Image no longer saved">
          <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg>
          <span>{image.fileName}</span>
        </span>
      {/if}
    {/each}
  </div>
{/snippet}

{#snippet toolStep(msg: ChatMessage)}
  {@const state = msg.type === "tool-call" ? "running" : msg.toolResult?.isError ? "error" : "done"}
  <!-- One line per tool step ("Edited Plan"); parameters and result open on click -->
  <details class="ochatting-tool" class:is-error={state === "error"} ontoggle={(e) => (msg.toolOpen = e.currentTarget.open)}>
    <summary class="ochatting-tool-row">
      {#if state === "running"}
        <span class="ochatting-spinner"></span>
      {:else if state === "error"}
        <svg class="ochatting-tool-icon" aria-label="Failed" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>
      {:else}
        <svg class="ochatting-tool-icon" aria-label="Done" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>
      {/if}
      <span class="ochatting-tool-label">{toolLabel(msg.toolName ?? "", msg.toolInput ?? {}, state)}</span>
      <span class="ochatting-tool-chevron" aria-hidden="true"></span>
    </summary>
    <!-- Built when opened: a long chat has many steps -->
    {#if msg.toolOpen}
      <div class="ochatting-tool-body">
        {#if msg.toolInput && Object.keys(msg.toolInput).length > 0}
          <div class="ochatting-tool-section">Parameters</div>
          <pre class="ochatting-tool-json">{truncate(JSON.stringify(msg.toolInput, null, 2), 2000)}</pre>
        {/if}
        {#if msg.toolResult}
          <div class="ochatting-tool-section">{state === "error" ? "Error" : "Result"}</div>
          <pre class="ochatting-tool-json">{truncate(msg.toolResult.result ?? "", 2000)}</pre>
        {/if}
      </div>
    {/if}
  </details>
{/snippet}

<!-- A user message's attached files, by name. -->
{#snippet fileChips(files: FileAttachment[])}
  <div class="ochatting-user-images">
    {#each files as file (file.id)}
      <span class="ochatting-image-chip" title={`${file.fileName}, ${formatBytes(file.sizeBytes)}`}>
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"></path><path d="M14 2v6h6"></path></svg>
        <span>{file.fileName}</span>
      </span>
    {/each}
  </div>
{/snippet}

<svelte:window onclick={closeUsageOutside} onkeydown={(e) => { if (e.key === "Escape") usageOpen = false; }} />

<div class="ochatting-container">
  <!-- Header -->
  <div class="ochatting-header">
    <button
      class="ochatting-icon-btn"
      class:is-active={historyOpen}
      type="button"
      onclick={toggleHistory}
      aria-label="Chats"
      aria-expanded={historyOpen}
      title="Chats"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path><path d="M12 7v5l4 2"></path></svg>
    </button>
    <div class="ochatting-header-left">
      <span class="ochatting-header-title" title={displayTitle}>{displayTitle || "New chat"}</span>
      <span class="ochatting-header-model">{displayModel || "No model"}</span>
    </div>
    {#if usage}
      {@const share = usage.contextWindow ? Math.min(1, usage.contextTokens / usage.contextWindow) : 0}
      <!-- How full the context is; a click shows the details -->
      <div class="ochatting-usage" bind:this={usageEl}>
        <button
          class="ochatting-icon-btn ochatting-usage-btn"
          class:is-full={usage.compactAt !== undefined && usage.contextTokens >= usage.compactAt}
          type="button"
          onclick={() => usageOpen = !usageOpen}
          aria-expanded={usageOpen}
          aria-label={usage.plan ? "Context" : "Context and cost"}
          title={usage.contextWindow ? `Context ${Math.round(share * 100)} % full` : `Context ${formatTokens(usage.contextTokens)} tokens`}
        >
          <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
            <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="2.5"></circle>
            {#if usage.contextWindow}
              <circle cx="10" cy="10" r="7.5" fill="none" stroke="currentColor" stroke-width="2.5"
                stroke-linecap="round" stroke-dasharray={`${(share * 47.12).toFixed(2)} 47.12`} transform="rotate(-90 10 10)"></circle>
            {/if}
          </svg>
        </button>
        {#if usageOpen}
          <div class="ochatting-usage-pop" role="dialog" aria-label={usage.plan ? "Context" : "Context and cost"}>
            <div class="ochatting-usage-row">
              <span>Context</span>
              <span>{formatTokens(usage.contextTokens)}{usage.contextWindow ? ` of ${formatTokens(usage.contextWindow)} (${Math.round(share * 100)} %)` : " tokens"}</span>
            </div>
            {#if usage.contextWindow}
              <div class="ochatting-usage-bar"><span style:width={`${(share * 100).toFixed(1)}%`}></span></div>
            {/if}
            <div class="ochatting-usage-row">
              <span>Tokens used</span>
              <span>{formatTokens(usage.inputTokens)} in · {formatTokens(usage.outputTokens)} out</span>
            </div>
            {#if usage.plan}
              <!-- No per-token cost on the plan; OpenAI gives apps no remaining-usage figure. -->
              <div class="ochatting-usage-row">
                <span>Plan</span>
                <span>Included in your ChatGPT plan · <a href={CHATGPT_USAGE_URL} target="_blank" rel="noopener">Manage usage</a></span>
              </div>
            {:else}
              <div class="ochatting-usage-row">
                <span>Cost</span>
                <span>
                  {#if usage.costUsd !== undefined}
                    {formatCost(usage.costUsd)} this chat{usage.lastTurnCostUsd !== undefined ? `, ${formatCost(usage.lastTurnCostUsd)} last answer` : ""}
                  {:else}
                    No prices known for this model
                  {/if}
                </span>
              </div>
              {#if usage.costUsd !== undefined}
                <div class="ochatting-usage-note">Estimated from the provider's list prices{usage.partialCost ? "; some requests had no price" : ""}.</div>
              {/if}
            {/if}
            <button
              class="ochatting-usage-compact"
              type="button"
              disabled={busy}
              onclick={() => { usageOpen = false; onCompact(); }}
              title="Replace the chat so far with a summary, written by the model"
            >Compact now</button>
          </div>
        {/if}
      </div>
    {/if}
    <button
      class="ochatting-follow-btn"
      class:is-active={followEdits}
      type="button"
      onclick={onToggleFollow}
      aria-label="Follow the AI's edits"
      aria-pressed={followEdits}
      title={followEdits ? "Following the AI's edits (click to stop)" : "Follow the AI's edits"}
    >
      {#if followEdits}
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"></path><circle cx="12" cy="12" r="3"></circle></svg>
      {:else}
        <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"></path><path d="M14.084 14.158a3 3 0 0 1-4.242-4.242"></path><path d="M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"></path><path d="m2 2 20 20"></path></svg>
      {/if}
    </button>
    <!-- Nothing to clear in an empty chat: the trash folds away until there is -->
    <button
      class="ochatting-clear-btn"
      class:ochatting-clear-folded={messages.length === 0}
      type="button"
      onclick={onClear}
      tabindex={messages.length === 0 ? -1 : undefined}
      aria-hidden={messages.length === 0 ? "true" : undefined}
      aria-label="Clear conversation"
      title="Clear conversation"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path><line x1="10" y1="11" x2="10" y2="17"></line><line x1="14" y1="11" x2="14" y2="17"></line></svg>
    </button>
    <button
      class="ochatting-icon-btn"
      type="button"
      onclick={newChat}
      aria-label="New chat"
      title="New chat"
    >
      <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"></path></svg>
    </button>
  </div>

  <div class="ochatting-body">
  {#if historyOpen}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div class="ochatting-history" role="dialog" aria-label="Chats" tabindex="-1" onkeydown={handleHistoryKeydown}>
      <div class="ochatting-history-head">
        <span class="ochatting-history-heading">Chats</span>
        <button type="button" class="mod-cta" onclick={newChat}>New chat</button>
      </div>
      {#if conversations.length === 0}
        <div class="ochatting-history-empty">No saved chats yet.</div>
      {/if}
      <ul class="ochatting-history-list">
        {#each conversations as conversation (conversation.id)}
          <li class="ochatting-history-row" class:is-active={conversation.active}>
            {#if renamingId === conversation.id}
              <input
                class="ochatting-history-rename"
                type="text"
                bind:value={renameText}
                use:renameBox
                aria-label="Chat name"
                onkeydown={(e) => handleRenameKeydown(e, conversation.id)}
                onblur={() => saveRename(conversation.id)}
              />
            {:else if deletingId === conversation.id}
              <span class="ochatting-history-confirm">Delete “{conversation.title}”?</span>
              <button type="button" onclick={() => deletingId = null}>Cancel</button>
              <button type="button" class="mod-warning" onclick={() => confirmDelete(conversation.id)}>Delete</button>
            {:else}
              <button
                class="ochatting-history-open"
                type="button"
                onclick={() => openConversation(conversation.id)}
                aria-current={conversation.active ? "true" : undefined}
              >
                <span class="ochatting-history-title">{conversation.title}</span>
                <span class="ochatting-history-date">
                  {#if conversation.running}<span class="ochatting-spinner ochatting-history-running" aria-hidden="true"></span>{/if}{conversation.running ? "Answering…" : formatDate(conversation.updatedAt)}
                  <!-- A large chat: its size, so it can be deleted when no longer needed -->
                  {#if (conversation.size ?? 0) > LARGE_CHAT_BYTES}
                    · <span class="ochatting-history-size" title="A large chat. Delete it if you no longer need it.">{formatBytes(conversation.size ?? 0)}</span>
                  {/if}
                </span>
              </button>
              <button
                class="ochatting-icon-btn"
                type="button"
                onclick={() => startRename(conversation)}
                aria-label={`Rename ${conversation.title}`}
                title="Rename"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>
              </button>
              <button
                class="ochatting-icon-btn"
                type="button"
                onclick={() => { renamingId = null; deletingId = conversation.id; }}
                aria-label={`Delete ${conversation.title}`}
                title="Delete"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path></svg>
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    </div>
  {/if}

  <!-- Messages -->
  <div class="ochatting-messages" class:is-reading-back={readingBack} bind:this={messagesEl}>
    <div class="ochatting-message-list" bind:this={messageListEl}>
    {#each messages as msg (msg.id)}
      {#if msg.type === "user"}
        <div class="ochatting-user-turn" class:ochatting-editing={editingId === msg.id}>
          {#if editingId === msg.id}
            <div class="ochatting-msg ochatting-user-msg ochatting-user-edit">
              {#if msg.images?.length}
                {@render userImages(msg.images)}
              {/if}
              {#if msg.attached?.length}
                {@render fileChips(msg.attached)}
              {/if}
              {#if msg.images?.some((image) => !image.data) || msg.attached?.some((file) => !file.data && !file.text)}
                <div class="ochatting-edit-note">Attachments no longer saved are left out.</div>
              {/if}
              {#if msg.selection}
                <div class="ochatting-edit-note">Selection from {msg.selection.filePath.split("/").pop()}</div>
              {/if}
              <textarea
                class="ochatting-edit-input"
                bind:value={editText}
                use:editBox
                rows="1"
                aria-label="Edit message"
                onkeydown={(e) => handleEditKeydown(e, msg)}
              ></textarea>
              <div class="ochatting-edit-note">Changes the AI already made to notes stay.</div>
              <div class="ochatting-edit-buttons">
                <button type="button" onclick={() => editingId = null}>Cancel</button>
                <button type="button" class="mod-cta" onclick={() => saveEdit(msg)}>Save</button>
              </div>
            </div>
          {:else}
            {#if msg.selection}
              <!-- What the message worked on, as the chat apps show a quote above it -->
              <div class="ochatting-msg-selection" title={msg.selection.text}>
                <span class="ochatting-msg-selection-label">Selection from {msg.selection.filePath.split("/").pop()}</span>
                <span class="ochatting-msg-selection-text">{msg.selection.text}</span>
              </div>
            {/if}
            <div class="ochatting-msg ochatting-user-msg">
              {#if msg.images?.length}
                {@render userImages(msg.images)}
              {/if}
              {#if msg.attached?.length}
                {@render fileChips(msg.attached)}
              {/if}
              {#if msg.text}
                <div class="ochatting-msg-content">{msg.text}</div>
              {/if}
            </div>
            {#if msg.turnId && editable(msg.turnId)}
              <div class="ochatting-msg-actions ochatting-hover-actions">
                <button
                  class="ochatting-action-btn"
                  type="button"
                  onclick={() => startEdit(msg)}
                  aria-label="Edit message"
                  title="Edit"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>
                </button>
              </div>
            {/if}
          {/if}
        </div>

      {:else if msg.type === "assistant"}
        <div class="ochatting-answer">
          <div class="ochatting-msg ochatting-assistant-msg">
            <div class="ochatting-msg-content" use:markdown={msg.text ?? ""}></div>
          </div>
          {#if !msg.streaming}
            <div class="ochatting-msg-actions" class:ochatting-hover-actions={msg.id !== lastAnswerId}>
              <button
                class="ochatting-action-btn"
                type="button"
                onclick={() => onCopy(msg.text ?? "")}
                aria-label="Copy answer"
                title="Copy"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              </button>
              {#if msg.id === lastAnswerId && !busy && (!lastTurnId || editable(lastTurnId))}
                <button
                  class="ochatting-action-btn"
                  type="button"
                  onclick={onRegenerate}
                  aria-label="Regenerate answer"
                  title="Regenerate"
                >
                  <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"></path><polyline points="21 3 21 8 16 8"></polyline></svg>
                </button>
              {/if}
            </div>
          {/if}
        </div>

      {:else if msg.type === "tool-call" || msg.type === "tool-result"}
        {@render toolStep(msg)}

      {:else if msg.type === "steps"}
        {@const files = msg.files ?? []}
        {@const failed = (msg.steps ?? []).filter((m) => m.type === "tool-result" && m.toolResult?.isError).length}
        <!-- A finished turn's work in one row above its answer; open: the steps, then the changed files -->
        <details class="ochatting-changes ochatting-steps" class:is-undone={msg.changesState === "undone"} bind:open={msg.stepsOpen}>
          <summary class="ochatting-changes-row">
            {#if failed}
              <svg class="ochatting-tool-icon ochatting-steps-failed" aria-label={failed === 1 ? "A step failed" : `${failed} steps failed`} xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"></path><path d="M12 9v4"></path><path d="M12 17h.01"></path></svg>
            {:else if files.length}
              <svg class="ochatting-tool-icon" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"></path><path d="M14 2v6h6"></path></svg>
            {:else}
              <svg class="ochatting-tool-icon" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"></path></svg>
            {/if}
            <span class="ochatting-changes-label" title={files.join("\n")}>{stepsLabel(msg)}</span>
            <span class="ochatting-tool-chevron" aria-hidden="true"></span>
            {#if msg.changesState === "undoable" && msg.turnId}
              {@const turnId = msg.turnId}
              <button
                class="ochatting-action-btn ochatting-changes-undo"
                type="button"
                disabled={busy}
                onclick={(e) => { e.preventDefault(); e.stopPropagation(); onUndo(turnId); }}
                aria-label="Undo these changes"
                title="Undo: put these files back as they were before this answer"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"></path><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"></path></svg>
              </button>
            {/if}
          </summary>
          <!-- Built when opened: a long chat has many folded turns -->
          {#if msg.stepsOpen}
            <div class="ochatting-steps-body">
              {#each msg.steps ?? [] as step (step.id)}
                {#if step.type === "assistant"}
                  <div class="ochatting-step-text" use:markdown={step.text ?? ""}></div>
                {:else}
                  {@render toolStep(step)}
                {/if}
              {/each}
              {#if files.length}
                <div class="ochatting-steps-files-label">{msg.changesState === "undone" ? "Changed back" : "Changed files"}</div>
                <ul class="ochatting-changes-list">
                  {#each files as path (path)}
                    <li><button type="button" class="ochatting-changes-file" onclick={() => openChanged(path)} title={path}>{path}</button></li>
                  {/each}
                </ul>
              {/if}
            </div>
          {/if}
        </details>

      {:else if msg.type === "error" && (msg.errorKind === "stopped" || msg.errorKind === "compacted")}
        <!-- Stopped before any of the answer arrived, or the earlier part summarized: a quiet note, not an error -->
        <div class="ochatting-stopped-note">{msg.text}</div>

      {:else if msg.type === "changes"}
        {@const files = msg.files ?? []}
        {@const verb = msg.changesState === "undone" ? "Undid the changes to" : "Changed"}
        <!-- What the answer changed, with undo (while Obsidian runs); open: the files as a list -->
        <details class="ochatting-changes" class:is-undone={msg.changesState === "undone"} bind:open={msg.changesOpen}>
          <summary class="ochatting-changes-row">
            <svg class="ochatting-tool-icon" aria-hidden="true" xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"></path><path d="M14 2v6h6"></path></svg>
            <span class="ochatting-changes-label" title={files.join("\n")}>
              {msg.changesOpen ? `${verb} ${files.length === 1 ? "1 file" : `${files.length} files`}` : `${verb} ${files.map(fileLabel).join(", ")}`}
            </span>
            <span class="ochatting-tool-chevron" aria-hidden="true"></span>
            {#if msg.changesState === "undoable" && msg.turnId}
              {@const turnId = msg.turnId}
              <button
                class="ochatting-action-btn ochatting-changes-undo"
                type="button"
                disabled={busy}
                onclick={(e) => { e.preventDefault(); e.stopPropagation(); onUndo(turnId); }}
                aria-label="Undo these changes"
                title="Undo: put these files back as they were before this answer"
              >
                <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 14 4 9l5-5"></path><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"></path></svg>
              </button>
            {/if}
          </summary>
          <ul class="ochatting-changes-list">
            {#each files as path (path)}
              <li><button type="button" class="ochatting-changes-file" onclick={() => openChanged(path)} title={path}>{path}</button></li>
            {/each}
          </ul>
        </details>

      {:else if msg.type === "error"}
        <div class="ochatting-msg ochatting-error-msg">
          <div class="ochatting-msg-content">{msg.text}</div>
        </div>

      {:else if msg.type === "thinking"}
        <div class="ochatting-thinking">
          <span class="ochatting-dot"></span>
          <span class="ochatting-dot"></span>
          <span class="ochatting-dot"></span>
          {#if msg.text}<span class="ochatting-thinking-label" aria-live="polite">{msg.text}</span>{/if}
        </div>
      {/if}
    {/each}
    </div>
    {#if showJump}
      <!-- Scrolled up: back to the latest message (sticks to the view's bottom edge) -->
      <button class="ochatting-jump-btn" type="button" onclick={jumpToBottom} aria-label="Scroll to the latest message" title="Scroll to the latest message">
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"></line><polyline points="19 12 12 19 5 12"></polyline></svg>
      </button>
    {/if}
  </div>

  {#if canContinue}
    <div class="ochatting-continue-row" role="status">
      <span>The last answer was interrupted.</span>
      <button class="mod-cta" type="button" onclick={continueTurn}>Continue</button>
    </div>
  {/if}

  {#if queued.length}
    <!-- Sent while the answer runs; each moves into the chat when the agent takes it in -->
    <div class="ochatting-queued" aria-live="polite">
      {#each queued as text, i (i)}
        <div class="ochatting-queued-item"><span class="ochatting-queued-label">Queued</span><span class="ochatting-queued-text">{text}</span></div>
      {/each}
    </div>
  {/if}

  <!-- Selection pill -->
  {#if selection}
    <div class="ochatting-selection-pill">
      <div class="ochatting-selection-content">
        <span class="ochatting-selection-label">Selection from {selection.filePath.split("/").pop()}</span>
        <span class="ochatting-selection-preview">{selection.text.substring(0, 80)}{selection.text.length > 80 ? "..." : ""}</span>
      </div>
      <button
        class="ochatting-selection-dismiss"
        onclick={() => selection = null}
        aria-label="Remove selection"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
      </button>
    </div>
  {/if}

  {#if attachments.length > 0 || fileAttachments.length > 0}
    <div class="ochatting-attachment-tray" aria-label="Attachments">
      {#each fileAttachments as file (file.id)}
        <div class="ochatting-attachment-preview">
          <span class="ochatting-attachment-icon" aria-hidden="true">
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"></path><path d="M14 2v6h6"></path></svg>
          </span>
          <span title={`${file.fileName}, ${formatBytes(file.sizeBytes)}`}>{file.fileName}</span>
          <button
            class="ochatting-attachment-remove"
            type="button"
            onclick={() => removeFile(file.id)}
            disabled={!inputEnabled}
            aria-label={`Remove ${file.fileName}`}
          >×</button>
        </div>
      {/each}
      {#each attachments as image (image.id)}
        <div class="ochatting-attachment-preview">
          <img src={imageDataUrl(image)} alt={image.fileName} />
          <span title={image.fileName}>{image.fileName}</span>
          <button
            class="ochatting-attachment-remove"
            type="button"
            onclick={() => removeAttachment(image.id)}
            disabled={!inputEnabled}
            aria-label={`Remove ${image.fileName}`}
          >×</button>
        </div>
      {/each}
    </div>
  {/if}

  {#if mention && mentionItems.length}
    <!-- Skills or files for what is being typed; mousedown keeps the focus in the input -->
    <div class="ochatting-mentions" role="listbox" aria-label={mentionItems[0].kind === "skill" ? "Use a skill" : "Link a file"}>
      {#each mentionItems as item, i (item.kind === "file" ? item.file.path : item.skill.path)}
        <div
          class="ochatting-mention"
          class:is-selected={i === mentionIndex}
          role="option"
          aria-selected={i === mentionIndex}
          tabindex="-1"
          onmousedown={(e) => { e.preventDefault(); chooseMention(item); }}
          onmousemove={() => { mentionIndex = i; }}
        >
          {#if item.kind === "skill"}
            <span class="ochatting-mention-name">/{item.skill.name}</span>
            {#if item.skill.description}<span class="ochatting-mention-folder">{item.skill.description}</span>{/if}
          {:else}
            <span class="ochatting-mention-name">{item.file.extension === "md" ? item.file.basename : item.file.name}</span>
            {#if folderOf(item.file)}<span class="ochatting-mention-folder">{folderOf(item.file)}</span>{/if}
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if voice}
    <!-- Voice: one row in place of the input, as in the chat apps' voice mode. The request and
         the answer land in the chat; the bar only shows what it hears right now. -->
    <div class="ochatting-voice-bar" role="region" aria-label="Voice conversation">
      {#if voice.holdToTalk}
        <button
          class="ochatting-voice-round ochatting-voice-mic ochatting-voice-talk"
          class:is-active={voice.micOn}
          type="button"
          aria-pressed={voice.micOn}
          aria-label="Hold to talk"
          title="Hold to talk"
          disabled={voice.status === "connecting" || voice.status === "reconnecting"}
          onpointerdown={talkStart}
          onpointerup={() => onVoice("talk-end")}
          onpointercancel={() => onVoice("talk-end")}
          onkeydown={(event) => talkKey(event, true)}
          onkeyup={(event) => talkKey(event, false)}
          oncontextmenu={(event) => event.preventDefault()}
        ><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" x2="12" y1="19" y2="22"></line></svg></button>
      {:else}
        <button
          class="ochatting-voice-round ochatting-voice-mic"
          class:is-muted={!voice.micOn}
          type="button"
          aria-pressed={!voice.micOn}
          aria-label={voice.micOn ? "Mute microphone" : "Unmute microphone"}
          title={voice.micOn ? "Mute microphone" : "Unmute microphone"}
          disabled={voice.status === "connecting" || voice.status === "reconnecting"}
          onclick={() => onVoice("mute")}
        >
          {#if voice.micOn}<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" x2="12" y1="19" y2="22"></line></svg>{:else}<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="2" x2="22" y1="2" y2="22"></line><path d="M18.89 13.23A7.12 7.12 0 0 0 19 12v-2"></path><path d="M5 10v2a7 7 0 0 0 12 5"></path><path d="M15 9.34V5a3 3 0 0 0-5.68-1.33"></path><path d="M9 9v3a3 3 0 0 0 5.12 2.12"></path><line x1="12" x2="12" y1="19" y2="22"></line></svg>{/if}
        </button>
      {/if}
      <div class="ochatting-voice-pill" aria-live="polite">
        {#if voice.audioBlocked}
          <button class="ochatting-voice-play" type="button" onclick={() => onVoice("play")}>Tap to play audio</button>
        {:else}
          <span class="ochatting-voice-wave" data-status={voice.status} aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></span>
          <span class="ochatting-voice-line" class:is-words={voice.you && (voice.status === "listening" || voice.status === "thinking")}>{voiceLine(voice)}</span>
        {/if}
      </div>
      <button
        class="ochatting-voice-round ochatting-voice-end"
        type="button"
        aria-label="End voice conversation"
        title="End voice conversation"
        onclick={() => onVoice("end")}
      ><svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg></button>
    </div>
  {:else}
  <!-- Input bar -->
  <div class="ochatting-input-bar">
    <input
      bind:this={fileInputEl}
      class="ochatting-file-input"
      type="file"
      accept={`image/jpeg,image/png,image/gif,image/webp,image/heic,image/heif,${ACCEPTED_FILES}`}
      multiple
      onchange={handleImageSelection}
      aria-label="Choose images or files"
    />
    <button
      class="ochatting-attach-btn"
      type="button"
      onclick={openImagePicker}
      disabled={!inputEnabled || busy || attachmentLoading || (attachments.length >= MAX_IMAGE_COUNT && fileAttachments.length >= MAX_FILE_COUNT)}
      aria-label="Attach images or files"
      title="Attach images or files"
    >
      <!-- A paperclip: images, PDFs, Office and text files -->
      <svg xmlns="http://www.w3.org/2000/svg" width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>
    </button>
    <textarea
      class="ochatting-input"
      class:ochatting-input-scrollable={inputScrollable}
      bind:this={textareaEl}
      bind:value={inputText}
      placeholder={askUserResolve ? "Type your answer..." : busy ? "Add to the running task..." : "Ask anything..."}
      disabled={!inputEnabled}
      rows="1"
      enterkeyhint={enterSends ? "send" : "enter"}
      onkeydown={handleKeydown}
      onpaste={handlePaste}
      oninput={() => { autoGrow(); updateMention(); }}
      onclick={updateMention}
      onblur={closeMention}
    ></textarea>
    <!-- One action slot, as in the chat apps: voice while there's nothing to send, else send; while a turn runs, Stop until there is text to add to it -->
    {#if busy && !inputText.trim()}
      <button
        class="ochatting-send-btn ochatting-stop-btn"
        onclick={onStop}
        aria-label="Stop generation"
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="4" y="4" width="16" height="16" rx="2"></rect></svg>
      </button>
    {:else if inputEnabled && !busy && showVoiceStart}
      <button
        class="ochatting-attach-btn ochatting-voice-start"
        type="button"
        onclick={() => onVoice("start")}
        aria-label="Start voice conversation"
        title="Start voice conversation"
      >
        <!-- Live voice, as in the chat apps: a filled circle with sound-wave bars (a microphone means dictation there) -->
        <svg xmlns="http://www.w3.org/2000/svg" width="26" height="26" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="currentColor"></circle><g class="ochatting-voice-bars" fill="none" stroke-width="2" stroke-linecap="round"><line x1="7.5" y1="10.5" x2="7.5" y2="13.5"></line><line x1="10.5" y1="7.5" x2="10.5" y2="16.5"></line><line x1="13.5" y1="9" x2="13.5" y2="15"></line><line x1="16.5" y1="10.5" x2="16.5" y2="13.5"></line></g></svg>
      </button>
    {:else}
      <button
        class="ochatting-send-btn"
        onclick={handleSend}
        disabled={attachmentLoading || composerLocked}
        aria-label={busy && !askUserResolve ? "Add to the running task" : "Send message"}
        title={composerLocked ? "Undo in progress..." : attachmentLoading ? "Preparing attachments..." : busy && !askUserResolve ? "Add to the running task" : "Send message"}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>
      </button>
    {/if}
  </div>
  {/if}
  </div>
</div>

<style>
  /* ─── Container ─────────────────────────────────────────────────────── */
  .ochatting-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  /* ─── Header ────────────────────────────────────────────────────────── */
  .ochatting-header {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--background-modifier-border);
    flex-shrink: 0;
  }

  /* Title above the model, so a long title doesn't push the model away */
  .ochatting-header-left {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  .ochatting-header-title {
    font-weight: var(--font-weight-bold, 600);
    font-size: var(--font-ui-medium);
    color: var(--text-normal);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Header and history list icons; 32px for touch, no hover-only controls. */
  .ochatting-icon-btn {
    width: 32px;
    height: 32px;
    min-width: 32px;
    padding: 0;
    border: none;
    border-radius: var(--radius-s);
    background: transparent;
    box-shadow: none;
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .ochatting-icon-btn:hover,
  .ochatting-icon-btn.is-active {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  /* ─── Context ring and its details ──────────────────────────────────── */
  .ochatting-usage {
    position: relative;
  }

  .ochatting-usage-btn.is-full {
    color: var(--text-warning);
  }

  .ochatting-usage-pop {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 20;
    width: min(280px, 80vw);
    padding: 10px 12px;
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-m);
    background: var(--background-primary);
    box-shadow: var(--shadow-s);
    font-size: var(--font-ui-smaller);
    color: var(--text-normal);
  }

  .ochatting-usage-row {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    margin-top: 6px;
  }

  .ochatting-usage-row:first-child {
    margin-top: 0;
  }

  .ochatting-usage-row span:first-child {
    color: var(--text-muted);
  }

  .ochatting-usage-row span:last-child {
    text-align: right;
  }

  .ochatting-usage-bar {
    height: 4px;
    margin: 6px 0;
    border-radius: 2px;
    background: var(--background-modifier-border);
    overflow: hidden;
  }

  .ochatting-usage-bar span {
    display: block;
    height: 100%;
    background: var(--interactive-accent);
  }

  .ochatting-usage-note {
    color: var(--text-faint);
    margin-top: 2px;
  }

  .ochatting-usage-compact {
    width: 100%;
    margin-top: 10px;
    font-size: var(--font-ui-smaller);
  }

  /* ─── Body: the chat, with the history list over it ─────────────────── */
  .ochatting-body {
    position: relative;
    flex: 1 1 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .ochatting-history {
    position: absolute;
    inset: 0;
    z-index: 2;
    display: flex;
    flex-direction: column;
    background: var(--background-primary);
    overflow-y: auto;
    overscroll-behavior: contain;
    padding: 8px;
  }

  .ochatting-history:focus {
    outline: none;
  }

  .ochatting-history-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 4px 4px 8px;
  }

  .ochatting-history-heading {
    font-weight: var(--font-weight-bold, 600);
    color: var(--text-normal);
  }

  .ochatting-history-empty {
    padding: 12px 4px;
    color: var(--text-muted);
    font-size: var(--font-ui-small);
  }

  .ochatting-history-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .ochatting-history-row {
    display: flex;
    align-items: center;
    gap: 4px;
    min-height: 44px;
    padding: 0 4px;
    border-radius: var(--radius-m);
  }

  .ochatting-history-row.is-active {
    background: var(--background-modifier-hover);
  }

  .ochatting-history-open {
    flex: 1;
    min-width: 0;
    min-height: 40px;
    height: auto;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: 1px;
    padding: 4px 6px;
    border: none;
    background: transparent;
    box-shadow: none;
    text-align: left;
    cursor: pointer;
  }

  .ochatting-history-title {
    max-width: 100%;
    color: var(--text-normal);
    font-size: var(--font-ui-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ochatting-history-date {
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
  }

  .ochatting-history-size {
    color: var(--text-warning);
  }

  /* A chat whose answer runs in the background */
  .ochatting-history-running {
    width: 8px;
    height: 8px;
    margin-right: 4px;
    border-width: 1.5px;
    vertical-align: -1px;
  }

  .ochatting-history-rename {
    flex: 1;
    min-width: 0;
    min-height: 36px;
  }

  .ochatting-history-confirm {
    flex: 1;
    min-width: 0;
    font-size: var(--font-ui-small);
    color: var(--text-normal);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ochatting-history-row button:not(.ochatting-icon-btn):not(.ochatting-history-open) {
    min-height: 32px;
  }

  .ochatting-header-model {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    /* Model name and thinking level can outgrow a phone-width panel */
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* Follow the AI's edits: an eye, highlighted while on; pushes itself and the trash right */
  .ochatting-follow-btn {
    width: 32px;
    height: 32px;
    min-width: 32px;
    margin-left: auto;
    padding: 0;
    border: none;
    border-radius: var(--radius-s);
    background: none;
    box-shadow: none;
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  .ochatting-follow-btn:hover,
  .ochatting-follow-btn.is-active {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  /* Clear: a red trash icon (it empties the conversation) */
  .ochatting-clear-btn {
    width: 32px;
    height: 32px;
    min-width: 32px;
    padding: 0;
    border: none;
    border-radius: var(--radius-s);
    background: none;
    box-shadow: none;
    color: var(--text-error);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    transition: width 200ms ease, min-width 200ms ease, margin 200ms ease, opacity 150ms ease, transform 200ms ease;
  }

  .ochatting-clear-btn:hover {
    background: var(--background-modifier-hover);
  }

  /* Folds away in an empty chat */
  .ochatting-clear-folded {
    width: 0;
    min-width: 0;
    margin-right: -4px; /* takes the header's gap with it, so no empty space is left */
    opacity: 0;
    transform: scale(0.5);
    overflow: hidden;
    pointer-events: none;
  }

  @media (prefers-reduced-motion: reduce) {
    .ochatting-clear-btn {
      transition: none;
    }
  }

  /* ─── Messages ──────────────────────────────────────────────────────── */
  .ochatting-messages {
    flex: 1 1 0;
    overflow-y: auto;
    overscroll-behavior: contain;
    /* The view follows the bottom itself (followBottom); no anchoring jumps */
    overflow-anchor: none;
    padding: 12px;
    -webkit-user-select: text;
    user-select: text;
  }

  /* Scrolled up: the browser keeps the view where it is when rows above
     change height (Safari doesn't; there the earlier turns are placed by
     prependMessages) */
  .ochatting-messages.is-reading-back {
    overflow-anchor: auto;
  }

  .ochatting-message-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  /* Rows off screen aren't laid out or painted; they keep their last size.
     Not on iOS: Safari doesn't keep the scroll position when a row above
     gets its real size. */
  :global(body:not(.is-ios)) .ochatting-message-list > * {
    content-visibility: auto;
    contain-intrinsic-block-size: auto 80px;
  }

  /* Round "to the latest message" button, stuck to the bottom edge of the view */
  .ochatting-jump-btn {
    position: sticky;
    bottom: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    margin: 8px auto 0;
    padding: 0;
    border: 1px solid var(--background-modifier-border);
    border-radius: 50%;
    background: var(--background-primary);
    color: var(--text-muted);
    box-shadow: var(--shadow-s);
    cursor: pointer;
  }

  .ochatting-jump-btn:hover {
    color: var(--text-normal);
  }

  .ochatting-msg {
    max-width: 90%;
    padding: 8px 12px;
    border-radius: var(--radius-m);
    line-height: 1.5;
    word-wrap: break-word;
    -webkit-user-select: text;
    user-select: text;
  }

  .ochatting-user-msg {
    align-self: flex-end;
    background: var(--interactive-accent);
    color: var(--text-on-accent);
    border-bottom-right-radius: var(--radius-s);
  }

  /* A user message with its edit action, or its edit box */
  .ochatting-user-turn {
    align-self: flex-end;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    max-width: 90%;
  }

  .ochatting-user-turn.ochatting-editing {
    width: 90%;
  }

  .ochatting-user-turn > .ochatting-msg,
  .ochatting-answer > .ochatting-msg {
    max-width: 100%;
  }

  .ochatting-user-edit {
    width: 100%;
    background: var(--background-secondary);
    color: var(--text-normal);
    border: 1px solid var(--interactive-accent);
    border-bottom-right-radius: var(--radius-m);
  }

  .ochatting-edit-input {
    width: 100%;
    resize: none;
    max-height: 300px;
    padding: 6px 8px;
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    background: var(--background-primary);
    color: var(--text-normal);
    font-family: var(--font-interface);
    font-size: var(--font-ui-medium);
    line-height: 1.4;
  }

  /* The selection a message was sent with: a muted quote above the bubble */
  .ochatting-msg-selection {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-width: 100%;
    margin-bottom: 4px;
    padding: 4px 10px;
    border-inline-start: 2px solid var(--interactive-accent);
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .ochatting-msg-selection-label {
    font-weight: var(--font-semibold);
  }

  .ochatting-msg-selection-text {
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    white-space: pre-line;
  }

  .ochatting-edit-note {
    margin: 4px 0;
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .ochatting-edit-buttons {
    display: flex;
    justify-content: flex-end;
    gap: 6px;
  }

  /* An answer with its action row */
  .ochatting-answer {
    align-self: flex-start;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    max-width: 90%;
  }

  /* ─── Message actions (edit, copy, regenerate) ──────────────────────── */
  .ochatting-msg-actions {
    display: flex;
    gap: 2px;
    margin-top: 2px;
  }

  .ochatting-action-btn {
    width: 26px;
    height: 26px;
    padding: 0;
    border: none;
    border-radius: var(--radius-s);
    background: transparent;
    box-shadow: none;
    color: var(--text-faint);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .ochatting-action-btn:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  /* With a mouse, these appear on hover; on touch screens they stay visible. */
  @media (hover: hover) and (pointer: fine) {
    .ochatting-hover-actions {
      opacity: 0;
      transition: opacity 0.15s;
    }

    .ochatting-user-turn:hover .ochatting-hover-actions,
    .ochatting-answer:hover .ochatting-hover-actions,
    .ochatting-hover-actions:focus-within {
      opacity: 1;
    }
  }

  @media (hover: none) {
    .ochatting-action-btn {
      width: 32px;
      height: 32px;
    }
  }

  .ochatting-user-images {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-bottom: 6px;
  }

  .ochatting-user-images img {
    max-width: min(100%, 280px);
    max-height: 220px;
    border-radius: var(--radius-s);
    object-fit: contain;
  }

  .ochatting-image-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    max-width: 100%;
    padding: 2px 8px;
    border-radius: var(--radius-s);
    background: rgba(0, 0, 0, 0.15);
    font-size: var(--font-ui-smaller);
  }

  .ochatting-image-chip span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ochatting-assistant-msg {
    align-self: flex-start;
    background: var(--background-secondary);
    color: var(--text-normal);
    border-bottom-left-radius: var(--radius-s);
  }

  .ochatting-assistant-msg :global(p:first-child) {
    margin-top: 0;
  }

  .ochatting-assistant-msg :global(p:last-child) {
    margin-bottom: 0;
  }

  .ochatting-error-msg {
    align-self: flex-start;
    background: var(--background-secondary);
    color: var(--text-error);
    border-left: 3px solid var(--text-error);
    font-size: var(--font-ui-smaller);
    max-width: 90%;
  }

  /* A turn cut off when Obsidian was ended: Continue */
  .ochatting-continue-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 12px;
    border-top: 1px solid var(--background-modifier-border);
    font-size: var(--font-ui-small);
    color: var(--text-muted);
    flex-shrink: 0;
  }

  /* Messages sent while the answer runs, until the agent takes them in */
  .ochatting-queued {
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 6px 12px 0;
    flex-shrink: 0;
  }

  .ochatting-queued-item {
    display: flex;
    gap: 8px;
    align-items: baseline;
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    min-width: 0;
  }

  .ochatting-queued-label {
    flex-shrink: 0;
    font-weight: var(--font-semibold);
    color: var(--text-faint);
  }

  .ochatting-queued-text {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ochatting-stopped-note {
    align-self: flex-start;
    font-size: var(--font-ui-smaller);
    font-style: italic;
    color: var(--text-faint);
    padding: 0 4px;
  }

  /* ─── Tool Calls ────────────────────────────────────────────────────── */
  /* A quiet line per tool step; consecutive steps sit close together */
  .ochatting-tool {
    align-self: stretch;
    max-width: 100%;
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .ochatting-tool + .ochatting-tool {
    margin-top: -6px;
  }

  .ochatting-tool-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 2px 4px;
    border-radius: var(--radius-s);
    cursor: pointer;
    list-style: none;
  }

  .ochatting-tool-row::-webkit-details-marker {
    display: none;
  }

  .ochatting-tool-row:hover {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .ochatting-tool-icon,
  .ochatting-tool-row .ochatting-spinner {
    flex-shrink: 0;
    color: var(--text-faint);
  }

  .ochatting-tool-row .ochatting-spinner {
    width: 10px;
    height: 10px;
    border-width: 1.5px;
  }

  .ochatting-tool.is-error .ochatting-tool-icon,
  .ochatting-tool.is-error .ochatting-tool-label {
    color: var(--text-error);
  }

  .ochatting-tool-label {
    flex: 0 1 auto;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* A small chevron after the label, turned down when open */
  .ochatting-tool-chevron {
    flex-shrink: 0;
    width: 6px;
    height: 6px;
    border-right: 1.5px solid currentColor;
    border-bottom: 1.5px solid currentColor;
    transform: rotate(-45deg);
    opacity: 0;
    transition: transform 150ms ease, opacity 150ms ease;
  }

  .ochatting-tool-row:hover .ochatting-tool-chevron,
  .ochatting-tool[open] .ochatting-tool-chevron {
    opacity: 0.7;
  }

  .ochatting-tool[open] .ochatting-tool-chevron {
    transform: rotate(45deg);
  }

  .ochatting-tool-body {
    margin: 2px 0 6px 22px;
  }

  .ochatting-tool-section {
    margin-top: 4px;
    color: var(--text-faint);
  }

  .ochatting-tool-json {
    margin: 4px 0 0;
    padding: 6px 8px;
    background: var(--background-primary);
    border-radius: var(--radius-s);
    font-size: 11px;
    max-height: 150px;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
  }

  /* ─── Changes of an answer (undo) ───────────────────────────────────── */
  .ochatting-changes {
    align-self: stretch;
    min-width: 0;
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
  }

  .ochatting-changes-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    padding: 2px 2px 2px 6px;
    cursor: pointer;
    list-style: none;
  }

  .ochatting-changes-row::-webkit-details-marker {
    display: none;
  }

  .ochatting-changes-row:hover .ochatting-tool-chevron,
  .ochatting-changes[open] .ochatting-tool-chevron {
    opacity: 0.7;
  }

  .ochatting-changes[open] .ochatting-tool-chevron {
    transform: rotate(45deg);
  }

  .ochatting-changes-label {
    flex: 0 1 auto;
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ochatting-changes.is-undone .ochatting-changes-label {
    color: var(--text-faint);
  }

  /* Undo stays at the row's right end */
  .ochatting-changes-undo {
    margin-left: auto;
    flex-shrink: 0;
  }

  /* A folded turn: a quiet line like a step (no box), undo right after it;
     open, its steps hang below on a thin guide line, then the changed files */
  .ochatting-changes.ochatting-steps {
    border: none;
  }

  .ochatting-steps > .ochatting-changes-row {
    padding: 2px 4px;
    border-radius: var(--radius-s);
  }

  .ochatting-steps .ochatting-changes-undo {
    margin-left: 0;
  }

  .ochatting-steps-body {
    display: flex;
    flex-direction: column;
    margin: 2px 0 4px 10px;
    padding-left: 8px;
    border-left: 1px solid var(--background-modifier-border);
  }

  .ochatting-step-text {
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
  }

  .ochatting-step-text :global(p) {
    margin: 2px 0;
  }

  .ochatting-steps-failed {
    color: var(--text-error);
  }

  .ochatting-steps-files-label {
    margin-top: 4px;
    padding: 0 4px;
    /* As visible as the step lines above it */
    color: var(--text-muted);
  }

  /* Open: the changed files as a bulleted list */
  .ochatting-steps .ochatting-changes-list {
    padding: 0 4px 2px 22px;
    list-style: disc;
  }

  .ochatting-steps .ochatting-changes-list li::marker {
    color: var(--text-muted);
  }

  /* Open: the files one per line */
  .ochatting-changes-list {
    margin: 0;
    padding: 0 8px 6px 26px;
    list-style: none;
  }

  .ochatting-changes-list li {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* File names look like links */
  .ochatting-changes-file {
    all: unset;
    color: var(--text-accent);
    cursor: pointer;
  }

  .ochatting-changes-file:hover {
    text-decoration: underline;
  }

  .ochatting-changes.is-undone .ochatting-changes-file {
    color: inherit;
    text-decoration: line-through;
  }

  /* ─── Spinner ───────────────────────────────────────────────────────── */
  .ochatting-spinner {
    display: inline-block;
    width: 12px;
    height: 12px;
    border: 2px solid var(--text-faint);
    border-top-color: var(--interactive-accent);
    border-radius: 50%;
    animation: ochatting-spin 0.6s linear infinite;
  }

  @keyframes ochatting-spin {
    to { transform: rotate(360deg); }
  }

  /* ─── Thinking Dots ─────────────────────────────────────────────────── */
  .ochatting-thinking {
    align-self: flex-start;
    display: flex;
    gap: 4px;
    padding: 8px 12px;
  }

  .ochatting-thinking-label {
    margin-left: 4px;
    color: var(--text-muted);
    font-size: var(--font-ui-small);
  }

  .ochatting-dot {
    width: 8px;
    height: 8px;
    background: var(--text-faint);
    border-radius: 50%;
    animation: ochatting-pulse 1.4s ease-in-out infinite;
  }

  .ochatting-dot:nth-child(2) {
    animation-delay: 0.2s;
  }

  .ochatting-dot:nth-child(3) {
    animation-delay: 0.4s;
  }

  @keyframes ochatting-pulse {
    0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
    40% { opacity: 1; transform: scale(1); }
  }

  /* ─── Input Bar ─────────────────────────────────────────────────────── */
  .ochatting-file-input {
    display: none;
  }

  .ochatting-attachment-tray {
    display: flex;
    gap: 8px;
    overflow-x: auto;
    padding: 8px 12px 0;
    flex-shrink: 0;
  }

  .ochatting-attachment-preview {
    position: relative;
    display: flex;
    align-items: center;
    gap: 6px;
    width: 190px;
    min-width: 190px;
    padding: 5px 28px 5px 5px;
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-s);
    background: var(--background-secondary);
  }

  .ochatting-attachment-icon {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 38px;
    height: 38px;
    flex-shrink: 0;
    border-radius: 4px;
    background: var(--background-modifier-hover);
    color: var(--text-muted);
  }

  .ochatting-attachment-preview img {
    width: 38px;
    height: 38px;
    flex-shrink: 0;
    border-radius: 4px;
    object-fit: cover;
  }

  .ochatting-attachment-preview span {
    min-width: 0;
    overflow: hidden;
    color: var(--text-muted);
    font-size: var(--font-ui-smaller);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ochatting-attachment-remove {
    position: absolute;
    top: 3px;
    right: 3px;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: var(--background-modifier-hover);
    color: var(--text-muted);
    cursor: pointer;
  }

  .ochatting-attachment-remove:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  /* No safe-area inset here: Obsidian's containers already keep it free. */
  .ochatting-input-bar {
    /* The buttons and one line of the input share this height, so they line up. */
    --ochatting-control: 36px;
    display: flex;
    /* Buttons stay at the bottom while the input grows to more lines. */
    align-items: flex-end;
    gap: 8px;
    padding: 8px 12px;
    border-top: 1px solid var(--background-modifier-border);
    background: transparent;
    flex-shrink: 0;
  }

  .ochatting-attach-btn {
    width: var(--ochatting-control);
    height: var(--ochatting-control);
    min-width: var(--ochatting-control);
    min-height: var(--ochatting-control);
    padding: 0;
    border: none;
    border-radius: 50%;
    /* A light circle the size of the send button; Obsidian's button shadow off */
    background: var(--background-modifier-hover);
    box-shadow: none;
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }

  /* Icons in proportion to the control size */
  .ochatting-attach-btn svg {
    width: calc(var(--ochatting-control) * 0.5);
    height: calc(var(--ochatting-control) * 0.5);
  }

  .ochatting-send-btn svg {
    width: calc(var(--ochatting-control) * 0.46);
    height: calc(var(--ochatting-control) * 0.46);
  }

  .ochatting-stop-btn svg {
    width: calc(var(--ochatting-control) * 0.4);
    height: calc(var(--ochatting-control) * 0.4);
  }

  .ochatting-attach-btn:hover {
    background: var(--background-modifier-active-hover);
    color: var(--text-normal);
  }

  .ochatting-attach-btn:disabled {
    cursor: not-allowed;
    opacity: 0.45;
  }

  .ochatting-input {
    flex: 1;
    resize: none;
    border: 1.5px solid var(--background-modifier-border-hover, var(--background-modifier-border));
    box-sizing: border-box;
    border-radius: calc(var(--ochatting-control) / 2);
    /* One line is exactly the control height: (height - line height - borders) / 2 */
    padding: calc((var(--ochatting-control) - 1.4em - 3px) / 2) 16px;
    min-height: var(--ochatting-control);
    font-size: var(--font-ui-medium);
    font-family: var(--font-interface);
    background-color: var(--background-secondary);
    color: var(--text-normal);
    line-height: 1.4;
    max-height: 300px;
    /* The height autoGrow() sets leaves out the borders, so the text
       overflowed it by 3px and showed an empty scrollbar track: a scrollbar
       only beyond the maximum height (autoGrow() turns it on). */
    overflow-y: hidden;
    box-shadow: none;
  }

  .ochatting-input-scrollable {
    overflow-y: auto;
  }

  .ochatting-input:focus {
    outline: none;
    border-color: var(--interactive-accent);
    box-shadow: none;
  }

  .ochatting-input:disabled {
    opacity: 0.5;
  }

  .ochatting-send-btn {
    width: var(--ochatting-control);
    height: var(--ochatting-control);
    min-width: var(--ochatting-control);
    min-height: var(--ochatting-control);
    padding: 0;
    border: none;
    border-radius: 50%;
    background-color: var(--interactive-accent);
    color: var(--text-on-accent);
    cursor: pointer;
    flex-shrink: 0;
    box-shadow: none;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-bottom: 1px;
  }

  .ochatting-send-btn:hover {
    background-color: var(--interactive-accent-hover);
  }

  .ochatting-send-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .ochatting-stop-btn {
    background-color: var(--text-error);
  }

  .ochatting-stop-btn:hover {
    background-color: var(--text-error);
    opacity: 0.85;
  }

  /* Live voice: a solid circle (text colour) with bars in the background colour */
  .ochatting-attach-btn.ochatting-voice-start {
    background: transparent;
    color: var(--text-normal);
  }

  .ochatting-voice-start svg {
    width: var(--ochatting-control);
    height: var(--ochatting-control);
  }

  .ochatting-voice-bars {
    stroke: var(--background-primary);
  }

  /* ─── Voice bar ──────────────────────────────────────────────────────── */
  /* One row like the input bar: mic, a pill with sound bars and one line, end */
  .ochatting-voice-bar {
    --ochatting-control: 36px;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-top: 1px solid var(--background-modifier-border);
    flex-shrink: 0;
    animation: ochatting-voice-in 200ms ease-out;
  }

  @keyframes ochatting-voice-in {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }

  .ochatting-voice-round {
    width: var(--ochatting-control);
    height: var(--ochatting-control);
    min-width: var(--ochatting-control);
    padding: 0;
    border: none;
    border-radius: 50%;
    box-shadow: none;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    flex-shrink: 0;
  }

  .ochatting-voice-round svg {
    width: calc(var(--ochatting-control) * 0.5);
    height: calc(var(--ochatting-control) * 0.5);
  }

  .ochatting-voice-mic {
    background: var(--background-modifier-hover);
    color: var(--text-normal);
  }

  .ochatting-voice-mic.is-muted {
    background: var(--background-modifier-error);
    color: var(--text-error);
  }

  .ochatting-voice-talk {
    touch-action: none;
    user-select: none;
    -webkit-user-select: none;
  }

  .ochatting-voice-talk.is-active {
    background: var(--interactive-accent);
    color: var(--text-on-accent);
  }

  .ochatting-voice-end {
    background: var(--color-red, var(--text-error));
    color: #fff;
  }

  .ochatting-voice-end:hover {
    opacity: 0.85;
  }

  /* Takes the input's place and shape */
  .ochatting-voice-pill {
    flex: 1;
    min-width: 0;
    height: var(--ochatting-control);
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 0 14px;
    border: 1.5px solid var(--background-modifier-border-hover, var(--background-modifier-border));
    border-radius: calc(var(--ochatting-control) / 2);
    background: var(--background-secondary);
    font-size: var(--font-ui-small);
  }

  /* Autoplay was blocked: a plain text button starts the audio */
  .ochatting-voice-play {
    padding: 0;
    border: none;
    background: none;
    box-shadow: none;
    color: var(--text-accent);
    font-size: inherit;
    cursor: pointer;
  }

  .ochatting-voice-line {
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* What it hears right now */
  .ochatting-voice-line.is-words {
    color: var(--text-normal);
  }

  /* Five sound bars: calm while listening, shimmering while busy, bouncing while speaking */
  .ochatting-voice-wave {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 16px;
    flex-shrink: 0;
  }

  .ochatting-voice-wave i {
    display: block;
    width: 3px;
    height: 100%;
    border-radius: 2px;
    background: var(--text-muted);
    transform: scaleY(0.3);
  }

  .ochatting-voice-wave i:nth-child(2) { animation-delay: 120ms; }
  .ochatting-voice-wave i:nth-child(3) { animation-delay: 240ms; }
  .ochatting-voice-wave i:nth-child(4) { animation-delay: 360ms; }
  .ochatting-voice-wave i:nth-child(5) { animation-delay: 480ms; }

  .ochatting-voice-wave[data-status="listening"] i {
    background: var(--color-green, var(--interactive-accent));
    animation: ochatting-voice-breathe 2.4s ease-in-out infinite;
  }

  .ochatting-voice-wave[data-status="speaking"] i {
    background: var(--interactive-accent);
    animation: ochatting-voice-bounce 0.9s ease-in-out infinite;
  }

  .ochatting-voice-wave[data-status="thinking"] i,
  .ochatting-voice-wave[data-status="connecting"] i,
  .ochatting-voice-wave[data-status="reconnecting"] i {
    animation: ochatting-voice-shimmer 1.2s ease-in-out infinite;
  }

  @keyframes ochatting-voice-breathe {
    0%, 100% { transform: scaleY(0.3); }
    50% { transform: scaleY(0.55); }
  }

  @keyframes ochatting-voice-bounce {
    0%, 100% { transform: scaleY(0.3); }
    50% { transform: scaleY(1); }
  }

  @keyframes ochatting-voice-shimmer {
    0%, 100% { opacity: 0.35; }
    50% { opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .ochatting-voice-bar,
    .ochatting-voice-wave i {
      animation: none;
    }
  }

  /* ─── Selection Pill ─────────────────────────────────────────────────── */
  .ochatting-selection-pill {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 8px 8px 0;
    padding: 6px 10px;
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-m);
    flex-shrink: 0;
  }

  .ochatting-selection-content {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .ochatting-selection-label {
    font-size: var(--font-ui-smaller);
    color: var(--text-muted);
    font-weight: 500;
  }

  .ochatting-selection-preview {
    font-size: var(--font-ui-smaller);
    color: var(--text-faint);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ochatting-selection-dismiss {
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: var(--background-modifier-hover);
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .ochatting-selection-dismiss:hover {
    background: var(--background-modifier-border);
    color: var(--text-normal);
  }

  /* ─── Mentions (the file list above the input) ──────────────────────── */
  .ochatting-mentions {
    margin: 8px 8px 0;
    padding: 4px;
    border: 1px solid var(--background-modifier-border);
    border-radius: var(--radius-m);
    background: var(--background-primary);
    box-shadow: var(--shadow-s);
    max-height: 260px;
    overflow-y: auto;
    flex-shrink: 0;
  }

  .ochatting-mention {
    display: flex;
    align-items: baseline;
    gap: 8px;
    min-width: 0;
    padding: 4px 8px;
    border-radius: var(--radius-s);
    cursor: pointer;
    font-size: var(--font-ui-small);
  }

  .ochatting-mention.is-selected {
    background: var(--background-modifier-hover);
  }

  .ochatting-mention-name {
    flex-shrink: 0;
    max-width: 70%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .ochatting-mention-folder {
    min-width: 0;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--text-faint);
    font-size: var(--font-ui-smaller);
  }

  /* ─── Responsive ────────────────────────────────────────────────────── */
  @media (max-width: 768px) {
    .ochatting-msg,
    .ochatting-user-turn,
    .ochatting-answer {
      max-width: 95%;
    }

    .ochatting-user-turn.ochatting-editing {
      width: 95%;
    }

    .ochatting-edit-input,
    .ochatting-history-rename {
      font-size: 16px; /* Prevents iOS zoom on focus */
    }

    .ochatting-input-bar,
    .ochatting-voice-bar {
      --ochatting-control: 44px; /* touch size */
      gap: 10px;
      padding: 10px 12px;
    }

    .ochatting-input {
      font-size: 16px; /* Prevents iOS zoom on focus */
    }
  }
</style>
