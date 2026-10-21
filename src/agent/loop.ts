import { App, Platform } from "obsidian";
import type {
  ChatSettings,
  UnifiedMessage,
  ContentBlock,
  AgentCallbacks,
  SelectionScope,
  ImageAttachment,
  ToolResult,
  MentionContext,
  FileAttachment,
  UnifiedResponse,
  VoiceTurn,
  SteeredMessage,
  ServerToolCall,
} from "../types";
import { sendMessage } from "../api/client";
import { ProviderError, StreamCutError } from "../api/errors";
import { isBuffered, lastChunkAt } from "../api/stream";
import { clearOpenAIState } from "../api/openai";
import { chatgptCompacts, chatgptReplayIdentity, clearChatGPTOAuthState } from "../api/chatgpt-oauth";
import { catalogModel, loadModelDetails, type ModelOption } from "../api/model-catalog";
import { serverToolName } from "../api/mcp";
import { TOOL_DEFINITIONS } from "../tools/registry";
import { executeTool } from "../tools/executor";
import { buildContext } from "./context";
import { folderInstructionContext, instructionsGiven, rootInstructions, toolPaths } from "./instructions";
import { findSkills, skillsPrompt } from "./skills";
import { buildSystemPrompt, buildContextMessage, voiceTranscriptText } from "./system-prompt";
import { cutBeforeTurn, editableTurn, fromLastCompaction, newTurnId, withoutOldToolImages, withoutToolAttachments, withoutLargeToolText, withoutLargeVisibleToolText, boundedToolText } from "./history";

import { debugLog } from "../debug";
import { attachmentBudgetError } from "../files/attachments";
import { RequestBudgetError } from "../api/request-budget";
import { appLifecycle } from "../platform/lifecycle";
import { afterCompaction, compactThreshold, summaryMessage } from "./compaction";
import { catalogIdentity } from "../api/model-catalog";
import { SUMMARY_SYSTEM_PROMPT, isContextOverflow, summaryChunks, summaryChunkRequest } from "./summary";

/** The turn ID of a summary message (it starts its own turn, with no visible entry). */
function summaryTurnId(): string {
  return `summary-${newTurnId()}`;
}

/**
 * The tool result of `ask_user` in a voice turn: the question ends the
 * turn as its answer (as Codex's background agent does) and the voice
 * hands over the user's spoken answer as the next request.
 */
export const VOICE_ASK_RESULT = "Asked aloud in the voice conversation. The user's answer comes as their next message.";
function displayServerCalls(calls: ServerToolCall[], callbacks: AgentCallbacks): void {
  const rows = withoutLargeVisibleToolText(calls.filter(call => !call.pending).map(call => ({
    name: serverToolName(call), input: call.input, toolResult: { result: call.result, isError: call.isError },
  })));
  for (const row of rows) {
    callbacks.onToolCall(row.name, row.input);
    callbacks.onToolResult(row.name, row.toolResult);
  }
}

/** Sending a request again (a cut-off stream, back from the background); tests shorten the wait. */
export const RESUME = {
  /** Requests sent again per turn at most; after that the error shows. */
  perTurn: 2,
  /**
   * Back in the foreground, an open request is given up after this long
   * (ms) without data, counted from the return or its last data.
   */
  stallMs: 30_000,
  /**
   * The same for a request through `requestUrl()`, which delivers its data
   * only at the end: a long answer may still be on its way, a request the
   * phone cut off never answers.
   */
  bufferedStallMs: 120_000,
};

/**
 * An error that may not come again: the network, an abort (the stall
 * watch), a cut stream, an error inside a started response, a timeout, a
 * rate limit or a server error. Not a request refused as too large or a
 * provider's other 4xx answers (a key, a quota, a bad request).
 */
function transient(e: unknown): boolean {
  if (e instanceof RequestBudgetError) return false;
  if (!(e instanceof ProviderError)) return true;
  if (["insufficient_quota", "usage_limit_reached", "usage_not_included"].includes(e.code ?? "")) return false;
  if (e.remoteEffectsPossible) return false;
  return e.status === 0 || e.status === 408 || e.status === 429 || e.status >= 500;
}

/**
 * Mobile: each time the app comes back while `request` is open, give it up
 * (abort) if no data arrives for `RESUME.stallMs`. A phone suspends the app
 * in the background, and a request open then may hang. A desktop window
 * keeps its requests running in the background, so it isn't watched.
 * Returns the function that stops watching.
 */
function watchForStall(request: AbortController): () => void {
  let timer = 0;
  let backAt = 0;
  const stopTimer = () => {
    if (timer) window.clearTimeout(timer);
    timer = 0;
  };
  const check = () => {
    const limit = isBuffered(request.signal) ? RESUME.bufferedStallMs : RESUME.stallMs;
    const quietMs = Date.now() - Math.max(backAt, lastChunkAt(request.signal) ?? 0);
    if (quietMs >= limit) request.abort();
    else timer = window.setTimeout(check, limit - quietMs);
  };
  const offVisible = appLifecycle.onVisible(() => {
    if (!Platform.isMobileApp) return;
    backAt = Date.now();
    stopTimer();
    timer = window.setTimeout(check, RESUME.stallMs);
  });
  const offHidden = appLifecycle.onHidden(stopTimer);
  return () => {
    offVisible();
    offHidden();
    stopTimer();
  };
}



/**
 * What the chat view shows and saves for a tool result: the text and a
 * marker, never the image or file data, which lives only in the agent
 * history (otherwise chat-state.json would hold it twice).
 */
function displayResult(result: ToolResult): ToolResult {
  const images = result.images?.length ?? 0;
  const files = result.files?.length ?? 0;
  if (!images && !files) return result;
  const what = [
    ...(images ? [images === 1 ? "1 image" : `${images} images`] : []),
    ...(files ? [files === 1 ? "1 file" : `${files} files`] : []),
  ].join(" and ");
  return {
    result: `${result.result}\n\n[${what} prepared for the model]`,
    isError: result.isError,
  };
}

/**
 * The core agentic loop:
 * 1. Send user message + history to API
 * 2. If response contains tool_use, execute tools, append results, loop
 * 3. If response is end_turn, deliver text to user, done
 * 4. Safety: stop after maxIterations to prevent runaway loops
 */
export class AgentLoop {
  private messages: UnifiedMessage[] = [];
  private app: App;
  private settings: ChatSettings;
  /** Counts runs and stops; a run whose number is no longer current is stopped. */
  private runVersion = 0;
  /**
   * Cancels the open HTTP request (streamed answers). One per request, so a
   * request that stalled in the background can be given up without
   * stopping the turn.
   */
  private request: AbortController | null = null;
  /** The run whose loop is working now (0: none); `steer()` adds to it. */
  private loopVersion = 0;
  /** Messages the user added while the loop works; sent with its next request (`steer`). */
  private steered: SteeredMessage[] = [];
  /** The running turn comes from a voice conversation (`ask_user` ends it). */
  private voiceTurn = false;
  /** Turns holding this loop (`hold()`). */
  private holds = 0;
  /** The vault root's AGENTS.md as the last turn read it (in the system prompt). */
  private vaultInstructions: string | null = null;
  /** The skills part of the system prompt, read with the instructions. */
  private skills: string | null = null;

  constructor(app: App, settings: ChatSettings) {
    this.app = app;
    this.settings = settings;
  }

  /** Abort a running loop (e.g. user navigates away) */
  abort(): void {
    this.runVersion++;
    this.steered = [];
    this.request?.abort();
  }

  /**
   * Add a message to the running turn, as the chat apps let you steer a
   * running task: it goes with the loop's next request, after the current
   * step. False when no loop is working (start a turn instead). What
   * arrives after the last step is returned by `takeSteered()`. `context`
   * goes to the model with it, not into the chat (what was said in voice
   * before the request).
   */
  steer(text: string, context?: VoiceTurn[]): boolean {
    if (!this.loopVersion || this.loopVersion !== this.runVersion) return false;
    this.steered.push({ text, ...(context !== undefined ? { context: context.map(turn => ({ ...turn })) } : {}) });
    debugLog(this.app, "STEER", { text, context });
    return true;
  }

  /** Added messages the finished turn didn't get to; they need a turn of their own. */
  takeSteered(): SteeredMessage[] {
    return this.steered.splice(0);
  }

  /** An uncertain voice transcript cannot survive as a typed next turn. */
  discardVoiceSteering(): SteeredMessage[] {
    const dropped = this.steered.filter(item => item.context !== undefined);
    this.steered = this.steered.filter(item => item.context === undefined);
    return dropped;
  }

  /** Stop a running turn and clear the history. */
  clear(): void {
    this.abort();
    this.messages = [];
    clearOpenAIState();
    clearChatGPTOAuthState();
  }

  /**
   * Stop a running turn and cut the history to just before the turn
   * `turnId` (editing a message, regenerating). The cut history is
   * a new array, so OpenAI replays it in full instead of chaining.
   */
  cutBeforeTurn(turnId: string): void {
    this.abort();
    this.messages = cutBeforeTurn(this.messages, turnId);
  }

  /** Turn `turnId` can be edited or answered again (after the last compaction, in the API history). */
  canEditTurn(turnId: string): boolean {
    return editableTurn(this.messages, turnId);
  }

  /** The API history as saved: from the last compaction on. */
  exportMessages(): UnifiedMessage[] {
    return fromLastCompaction(this.messages);
  }

  /** Continue from a saved API history (a new array). */
  importMessages(messages: UnifiedMessage[]): void {
    this.messages = withoutLargeToolText([...messages]);
    this.pruneToolImages();
    clearOpenAIState();
    clearChatGPTOAuthState();
  }

  /** Retention may remove blobs while a request/tool is in flight. Keep the
   * inner result arrays, but detach the provider's old outer-array cursor. */
  invalidateHistoryCursor(): void {
    this.messages = [...this.messages];
    clearOpenAIState();
    clearChatGPTOAuthState();
  }

  /** What the last compaction covers leaves memory too (`fromLastCompaction`). */
  trimForRetention(): void {
    const retained = fromLastCompaction(this.messages);
    if (retained !== this.messages) {
      this.messages = retained;
      this.invalidateHistoryCursor();
    }
  }

  /**
   * Marks a turn as running from before it starts to after it ends (the
   * chat view holds it): the plugin keeps a running conversation's loop
   * when the user switches away. Returns the release.
   */
  hold(): () => void {
    this.holds++;
    let released = false;
    return () => {
      if (!released) this.holds--;
      released = true;
    };
  }

  isRunning(): boolean {
    return this.holds > 0;
  }

  // ─── Compaction ───────────────────────────────────────────────────────
  // The provider compacts where it can (a parameter of each request); the
  // plugin writes a summary where it can't.

  /**
   * Summarize the whole history now (*Compact now*): it becomes one
   * message with the summary. False when nothing was done (empty, a turn
   * runs, stopped). Throws when the summary request fails.
   */
  async compact(onUsage?: AgentCallbacks["onUsage"]): Promise<boolean> {
    if (this.messages.length === 0 || this.loopVersion) return false;
    const version = ++this.runVersion;
    const isStopped = () => version !== this.runVersion;
    const summary = await this.summarize({ ...this.settings }, this.messages, isStopped, onUsage);
    if (isStopped()) return false;
    this.messages = [summaryMessage(summary, summaryTurnId())];
    debugLog(this.app, "COMPACTED", { reason: "user", chars: summary.length });
    return true;
  }

  /**
   * Before a turn: a summary where the provider can't help.
   * - The last compaction is another provider's or model's and has no
   *   readable summary (OpenAI's is encrypted): it gets one now, once.
   * - The provider doesn't compact (unsupported, refused or the window
   *   unknown to it) and the last request (`contextTokens`) passed the
   *   compaction point: the history is summarized now.
   * A failed summary doesn't stop the turn.
   */
  private async prepareContext(settings: ChatSettings, contextTokens: number, callbacks: AgentCallbacks, isStopped: () => boolean): Promise<void> {
    try {
      let handedOff = false;
      const index = this.messages.map((message) => !!message.compaction).lastIndexOf(true);
      const marker = this.messages[index];
      const replay = marker?.replay;
      let replayable = replay?.provider === settings.provider && (!replay.model || replay.model === settings.model);
      if (replayable && replay?.identity && marker?.compaction && !marker.compaction.summary) {
        const identity = settings.provider === "chatgpt-oauth" ? await chatgptReplayIdentity() :
          await catalogIdentity(settings.provider, settings.apiKey);
        replayable = replay.identity === identity;
        if (isStopped()) return;
      }
      if (marker?.compaction && !marker.compaction.summary && !replayable && index > 0) {
        const summary = await this.summarize(settings, this.messages.slice(0, index), isStopped, callbacks.onUsage);
        if (isStopped()) return;
        marker.compaction = { summary };
        handedOff = true;
        debugLog(this.app, "COMPACTED", { reason: "provider switch" });
      }
      const option = catalogModel(settings.provider, settings.model);
      const threshold = compactThreshold(settings.provider, option, settings);
      if (!handedOff && !isStopped() && threshold && contextTokens >= threshold && !this.compactsNatively(settings, option) && this.messages.length) {
        const summary = await this.summarize(settings, this.messages, isStopped, callbacks.onUsage);
        if (isStopped()) return;
        this.messages = [summaryMessage(summary, summaryTurnId())];
        debugLog(this.app, "COMPACTED", { reason: "threshold", contextTokens, threshold });
        callbacks.onCompacted?.();
      }
    } catch (e) {
      debugLog(this.app, "COMPACTION_FAILED", { error: e instanceof Error ? e.message : String(e) });
    }
  }

  /** The provider compacts this model's context on its side. */
  private compactsNatively(settings: ChatSettings, option: ModelOption | undefined): boolean {
    if (settings.provider === "anthropic") return option?.compaction === true;
    if (settings.provider === "chatgpt-oauth") return chatgptCompacts();
    return true;
  }

  /**
   * The request didn't fit: summarize what came before the running turn,
   * once per turn, and send again. False when there is nothing before it
   * or the summary failed.
   */
  private async compactForOverflow(settings: ChatSettings, callbacks: AgentCallbacks, isStopped: () => boolean): Promise<boolean> {
    const start = this.messages.map((message) => !!message.turnId).lastIndexOf(true);
    if (start <= 0) return false;
    try {
      const summary = await this.summarize(settings, this.messages.slice(0, start), isStopped, callbacks.onUsage);
      if (isStopped()) return false;
      this.messages = [summaryMessage(summary, summaryTurnId()), ...this.messages.slice(start)];
      debugLog(this.app, "COMPACTED", { reason: "overflow" });
      callbacks.onCompacted?.();
      return true;
    } catch (e) {
      debugLog(this.app, "COMPACTION_FAILED", { error: e instanceof Error ? e.message : String(e) });
      return false;
    }
  }

  /**
   * A summary of `messages` by the provider (a transcript; no tools, web
   * search or MCP servers); Stop cancels it. Its tokens count like a
   * request of the chat (`onUsage`).
   */
  private async summarize(settings: ChatSettings, messages: UnifiedMessage[], isStopped: () => boolean,
    onUsage?: AgentCallbacks["onUsage"]): Promise<string> {
    const identity = settings.provider === "chatgpt-oauth" ? await chatgptReplayIdentity() : await catalogIdentity(settings.provider, settings.apiKey);
    const window = settings.modelCatalog?.entries.find(entry => entry.provider === settings.provider && entry.identity === identity)
      ?.models.find(model => model.value === settings.model)?.contextWindow;
    const request = new AbortController();
    this.request = request;
    try {
      let summary = "";
      for (const chunk of summaryChunks(messages, window)) {
        if (isStopped()) throw new Error("Summarization stopped.");
        const response = await sendMessage({ ...settings, enableWebSearch: false, mcpServers: [] },
          [{ role: "user", content: summaryChunkRequest(chunk, summary) }], [], SUMMARY_SYSTEM_PROMPT, isStopped, { signal: request.signal });
        if (response.usage) onUsage?.(response.usage, { provider: settings.provider, model: settings.model, turnStart: false });
        const text = response.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("").trim();
        if (!text) throw new Error("The summary came back empty.");
        summary = text;
      }
      return summary;
    } finally {
      if (this.request === request) this.request = null;
    }
  }

  /** Nothing in the API history yet. */
  isEmpty(): boolean {
    return this.messages.length === 0;
  }

  /**
   * The history ends in a user message or tool results, waiting for an
   * answer; with `turnId`, the last turn there must be that one (a turn
   * whose message never reached the history isn't continued as another).
   */
  owesAnswer(turnId?: string): boolean {
    if (this.messages.at(-1)?.role !== "user") return false;
    if (turnId === undefined) return true;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const id = this.messages[i].turnId;
      if (this.messages[i].role === "user" && id) return id === turnId;
    }
    return false;
  }

  /** Export the full conversation as a readable markdown transcript */
  exportTranscript(): string {
    const systemPrompt = buildSystemPrompt(this.vaultInstructions, this.skills);

    const parts: string[] = [
      `# Chatting with AI Transcript`,
      ``,
      `**Date:** ${new Date().toISOString()}`,
      `**Provider:** ${this.settings.provider}`,
      `**Model:** ${this.settings.model}`,
      ``,
      `## System Prompt`,
      ``,
      "```",
      systemPrompt,
      "```",
      ``,
      `## Conversation`,
      ``,
    ];

    for (const msg of this.messages) {
      if (typeof msg.content === "string") {
        parts.push(`### ${msg.role === "user" ? "User" : "Assistant"}`);
        parts.push(``);
        parts.push(msg.content);
        parts.push(``);
      } else {
        // Content blocks
        for (const block of msg.content) {
          if (block.type === "text" && block.text) {
            parts.push(`### ${msg.role === "user" ? "User" : "Assistant"}`);
            parts.push(``);
            parts.push(block.text);
            parts.push(``);
          } else if (block.type === "image" && block.image) {
            parts.push(`[Image attachment: ${block.image.fileName}]`);
            parts.push(``);
          } else if (block.type === "file" && block.file) {
            parts.push(`[File attachment: ${block.file.fileName}]`);
            parts.push(``);
          } else if (block.type === "tool_use") {
            parts.push(`### Tool Call: \`${block.name}\``);
            parts.push(``);
            parts.push("```json");
            parts.push(JSON.stringify(block.input, null, 2));
            parts.push("```");
            parts.push(``);
          } else if (block.type === "tool_result") {
            parts.push(`### Tool Result ${block.is_error ? "(ERROR)" : ""}`);
            parts.push(``);
            parts.push("```");
            parts.push(block.content || "(empty)");
            parts.push("```");
            parts.push(``);
            for (const image of block.images ?? []) {
              parts.push(`[Image: ${image.fileName}]`);
              parts.push(``);
            }
            for (const file of block.files ?? []) {
              parts.push(`[File: ${file.fileName}]`);
              parts.push(``);
            }
          }
        }
      }
    }

    return parts.join("\n");
  }

  /**
   * Run one user turn through the agentic loop; `turnId` marks where it
   * starts. `mentioned`: the files the message links to, sent before it.
   * `notes`: what the user did since the last turn (e.g. undid an answer's
   * changes), for the model.
   * `files`: PDF, Office and text files the user attached.
   * `contextTokens`: the conversation's context after its last request;
   * past the compaction point the plugin summarizes first where the
   * provider doesn't compact.
   * `voice`: the turn comes from a voice conversation (its context asks
   * for a short, speakable answer), with what was said there before the
   * request; null for a typed turn.
   */
  async run(
    userMessage: string,
    callbacks: AgentCallbacks,
    selection?: SelectionScope | null,
    images: ImageAttachment[] = [],
    turnId: string = newTurnId(),
    mentioned: MentionContext | null = null,
    notes: string[] = [],
    files: FileAttachment[] = [],
    contextTokens = 0,
    voice: VoiceTurn[] | null = null
  ): Promise<void> {
    const version = ++this.runVersion;
    const isStopped = () => version !== this.runVersion;
    this.voiceTurn = !!voice;
    // This turn's selection: the tools change only that text of its note (a
    // copy, since its text follows the edits).
    const scope = selection ? { ...selection } : undefined;
    // Keep one provider/model/credential configuration for this entire turn.
    // MCP revocation stays live even inside the dispatcher's retry wait.
    const currentServers = () => this.settings.mcpServers?.map(server => ({ ...server })) ?? [];
    const turnSettings = { ...this.settings, get mcpServers() { return currentServers(); } };

    // Build context once per user turn and prepend to the user message;
    // the files the message links to come next, the message itself last.
    const context = { ...buildContext(this.app, !!voice, voice ?? []), ...(notes.length ? { notes } : {}) };
    let contextPrefix = mentioned ? `${buildContextMessage(context)}

${mentioned.text}` : buildContextMessage(context);
    images = [...images, ...mentioned?.images ?? []];
    files = [...files, ...mentioned?.files ?? []];
    const budgetError = attachmentBudgetError(images, files);
    if (budgetError) {
      (callbacks.onPreflightRejected ?? callbacks.onError)(budgetError);
      return;
    }
    // The history before this turn: a refusal before the provider (rules
    // that can't be read, a request too large) restores it, also when the
    // summary below replaced it.
    const beforeTurn = this.messages.slice();
    // A summary first where the provider can't compact.
    await this.prepareContext(turnSettings, contextTokens, callbacks, isStopped);
    if (isStopped()) return;
    let instructionSources: string[] = [];
    try {
      const prospective: UnifiedMessage[] = [...this.messages, { role: "user", content: "", turnId }];
      // Rules given before the last compaction are gone with it: given again.
      const retained = afterCompaction(prospective, () => true);
      const paths = [...mentioned?.instructionPaths ?? [], ...selection ? [selection.filePath] : []];
      const rules = await folderInstructionContext(this.app, paths, instructionsGiven(retained));
      if (isStopped()) return;
      instructionSources = rules.sources;
      if (rules.text) contextPrefix = `${rules.text}\n\n${contextPrefix}`;
    } catch (e) {
      if (isStopped()) return;
      this.messages = beforeTurn;
      (callbacks.onPreflightRejected ?? callbacks.onError)(e instanceof Error ? e.message : String(e));
      return;
    }

    // If there's a selection, inject it as scoped context
    let fullMessage: string;
    if (selection) {
      fullMessage = [
        contextPrefix,
        "",
        `[Selection scope: The user has selected text in ${selection.filePath}. Work only within this selection. When using edit_document, use find_replace with text from within this selection; 'find' is matched inside the selection, so no surrounding context is needed. Do not modify text outside the selection.]`,
        "",
        `Selected text:`,
        selection.text.split(/\r?\n/).map((line) => `> ${line}`).join("\n"),
        "",
        userMessage,
      ].join("\n");
    } else {
      fullMessage = `${contextPrefix}\n\n${userMessage}`;
    }

    const content: string | ContentBlock[] = images.length > 0 || files.length > 0
      ? [
          ...images.map((image): ContentBlock => ({ type: "image", image })),
          ...files.map((file): ContentBlock => ({ type: "file", file })),
          { type: "text", text: fullMessage },
        ]
      : fullMessage;
    this.messages.push({ role: "user", content, turnId, ...(instructionSources.length ? { instructionSources } : {}) });

    // What the last compaction covers goes; a new array only then, so
    // OpenAI keeps chaining and the prompt caches keep their prefix.
    this.messages = fromLastCompaction(this.messages);
    this.pruneToolImages();

    debugLog(this.app, "USER_MESSAGE", {
      userMessage,
      // As the model gets it: the context lines (open note, voice context, notes, linked files) first.
      sent: fullMessage,
      model: turnSettings.model,
      provider: turnSettings.provider,
      hasSelection: !!selection,
      imageCount: images.length,
      imageNames: images.map((image) => image.fileName),
      fileNames: files.map((file) => file.fileName),
    });

    await this.loop(version, callbacks, turnSettings, scope, beforeTurn);
  }

  /**
   * Continue the turn the history ends in, cut off before the model
   * answered (Obsidian was ended in the background): the loop runs on the
   * history as it is, without a new user message. Tool results already
   * there are sent, not run again. The view supplies the original saved
   * selection; its fingerprint still refuses writes after the note changed.
   */
  async continueTurn(callbacks: AgentCallbacks, selection?: SelectionScope): Promise<void> {
    const version = ++this.runVersion;
    this.voiceTurn = false;
    if (!this.owesAnswer()) return;
    debugLog(this.app, "CONTINUE_TURN", { messages: this.messages.length });
    const currentServers = () => this.settings.mcpServers?.map(server => ({ ...server })) ?? [];
    const turnSettings = { ...this.settings, get mcpServers() { return currentServers(); } };
    await this.prepareContext(turnSettings, 0, callbacks, () => version !== this.runVersion);
    if (version !== this.runVersion) return;
    await this.loop(version, callbacks, turnSettings, selection ? { ...selection } : undefined);

  }

  /** The agentic loop on the current history, for run `version`; `steer()` adds to it meanwhile. */
  private async loop(
    version: number,
    callbacks: AgentCallbacks,
    turnSettings: ChatSettings,
    scope: SelectionScope | undefined,
    beforeTurn?: UnifiedMessage[]
  ): Promise<void> {
    this.loopVersion = version;
    try {
      await this.steps(version, callbacks, turnSettings, scope, beforeTurn);
    } finally {
      if (this.loopVersion === version) this.loopVersion = 0;
    }
  }

  /** `beforeTurn`: the history before a new user turn, restored if its first request is refused as too large. */
  private async steps(
    version: number,
    callbacks: AgentCallbacks,
    turnSettings: ChatSettings,
    scope: SelectionScope | undefined,
    beforeTurn?: UnifiedMessage[]
  ): Promise<void> {
    const isStopped = () => version !== this.runVersion;
    const onTextDelta = (text: string) => {
      if (!isStopped()) callbacks.onTextDelta?.(text);
    };
    // System prompt is static (cache-friendly): the built-in one, the
    // vault's skills and its AGENTS.md, which rarely change. Read once per turn.
    this.vaultInstructions = await rootInstructions(this.app);
    this.skills = skillsPrompt(findSkills(this.app, turnSettings.skillsFolder));
    const systemPrompt = buildSystemPrompt(this.vaultInstructions, this.skills);
    const maxIterations = turnSettings.maxIterations || 20;
    let undoBudgetReported = false;
    let resends = 0;
    // A request too long for the model is summarized and sent again, once per turn.
    let overflowCompacted = false;

    for (let i = 0; i < maxIterations; i++) {
      if (isStopped()) return;
      callbacks.onThinking();
      if (isStopped()) return;

      let response: UnifiedResponse | undefined;
      while (!response) {
        const startedAt = Date.now();
        try {
          response = await this.send(turnSettings, systemPrompt, isStopped, onTextDelta, callbacks.onRequestStarted);
        } catch (e) {
          if (isStopped()) return;
          if (!overflowCompacted && isContextOverflow(e) && !(e instanceof ProviderError && e.remoteEffectsPossible)) {
            overflowCompacted = true;
            callbacks.onThinking();
            if (await this.compactForOverflow(turnSettings, callbacks, isStopped)) continue;
            if (isStopped()) return;
          }
          const msg = e instanceof Error ? e.message : String(e);
          if (e instanceof ProviderError && e.partialResponse) {
            this.keepRemoteReceipts(e.partialResponse, callbacks);
            const partialText = e.partialResponse.content.filter(block => block.type === "text").map(block => block.text).join("");
            if (partialText) callbacks.onResponse(partialText);
          }
          // The stream was cut off (a dropped connection, no provider error),
          // or the request failed or was given up while Obsidian was in the
          // background: send the same request again, once Obsidian is
          // visible. The history holds every completed step, so nothing runs twice.
          // Not after a tool on an MCP server started (it may have changed
          // something), and not an error that would only come again (a request
          // refused as too large, or a provider's 4xx answer other than 408/429).
          const background = transient(e) && appLifecycle.hiddenSince(startedAt);
          const cut = e instanceof StreamCutError && !e.sideEffects;
          if (resends < RESUME.perTurn && (cut || background) && !(e instanceof StreamCutError && e.sideEffects) &&
              !(e instanceof ProviderError && e.remoteEffectsPossible)) {

            resends++;
            debugLog(this.app, "API_RESEND", { error: msg, resend: resends, background });
            await appLifecycle.whenVisible();
            if (isStopped()) return;
            // The failed attempt's streamed text goes; the answer streams anew.
            if (background) callbacks.onResuming?.();
            else callbacks.onThinking();
            if (isStopped()) return;
            continue;
          }
          // A later request grown over the size limit by tool attachments:
          // drop them (and oversized tool text) once and send again.
          if (i > 0 && e instanceof RequestBudgetError) {
            const reduced = withoutLargeToolText(withoutToolAttachments(this.messages));
            if (reduced !== this.messages) {
              this.messages = reduced;
              clearOpenAIState();
              clearChatGPTOAuthState();
              continue;
            }

          }
          debugLog(this.app, "API_ERROR", { error: msg, model: this.settings.model, provider: this.settings.provider });
          if (i === 0 && e instanceof RequestBudgetError && beforeTurn) {
            // Nothing reached the provider or tools. Undo local pruning and
            // the pending user turn so its attachments cannot poison retries.
            this.messages = beforeTurn;
            clearOpenAIState();
            clearChatGPTOAuthState();
            (callbacks.onPreflightRejected ?? callbacks.onError)(msg);
            return;
          }
          callbacks.onError(msg);
          return;
        }
      }

      debugLog(this.app, "API_RESPONSE", {
        stopReason: response.stopReason, usage: response.usage,
        // The answer as received: text, and tool calls with their parameters.
        content: response.content.map((block) =>
          block.type === "text" ? { type: "text", text: block.text }
          : block.type === "tool_use" ? { type: "tool_use", name: block.name, input: block.input }
          : { type: block.type }),
        ...(response.serverCalls ? { serverCalls: response.serverCalls } : {}),
        // Whether the provider compacts on its side now (the ChatGPT route may refuse it).
        compactsNatively: this.compactsNatively(turnSettings, catalogModel(turnSettings.provider, turnSettings.model)),
        ...(response.compaction ? { compacted: true } : {}),
      });
      if (response.usage) {
        // The model's window and prices for the ring (OpenAI: its documentation page, once a day).
        if (i === 0) {
          void loadModelDetails(turnSettings.modelCatalog, turnSettings.provider, turnSettings.apiKey, turnSettings.model)
            .then((changed) => { if (changed) callbacks.onModelDetails?.(); }, () => undefined);
        }
        callbacks.onUsage?.(response.usage, { provider: turnSettings.provider, model: turnSettings.model, turnStart: i === 0 });
      }

      if (isStopped()) return;

      // Tools the provider called on MCP servers: shown as steps, not run here.
      displayServerCalls(response.serverCalls ?? [], callbacks);

      // Do not execute or persist truncated tool arguments as a completed call.
      if (response.stopReason === "max_tokens") {
        const text = response.content.filter(block => block.type === "text").map(block => block.text).join("");
        if (response.serverCalls?.length) {
          // Remote effects have already happened. Retain their receipts so a
          // follow-up cannot lose them, while discarding partial local calls.
          this.keepRemoteReceipts(response);
        }
        if (text) callbacks.onResponse(text);
        callbacks.onError("The response reached its token limit before completing. Please try a smaller request." +
          (response.serverCalls?.length ? " Remote MCP tools may already have run; check their results before retrying." : ""));
        return;
      }

      // Process response content blocks
      const toolCalls: ContentBlock[] = [];
      const textParts: string[] = [];

      for (const block of response.content) {
        if (block.type === "text" && block.text) {
          textParts.push(block.text);
        } else if (block.type === "tool_use") {
          toolCalls.push(block);
        }
      }

      // Emit any text before tool calls (skip if ask_user is coming to avoid
      // rendering the question twice: once as text and once via showAskUser)
      const hasAskUser = toolCalls.some((tc) => tc.name === "ask_user");
      if (textParts.length > 0 && toolCalls.length > 0 && !hasAskUser) {
        callbacks.onResponse(textParts.join(""));
      }

      if (isStopped()) return;

      // Append assistant message to history
      this.messages.push({
        role: "assistant", content: response.content, replay: response.replay,
        ...(response.compaction ? { compaction: response.compaction } : {}),
      });
      if (response.compaction) callbacks.onCompacted?.();
      // Results of MCP calls stay in the replay: bounded like tool text.
      if (response.serverCalls?.length) this.messages = withoutLargeToolText(this.messages);

      // If no tool calls, we're done
      if (toolCalls.length === 0) {
        if (textParts.length > 0) {
          callbacks.onResponse(textParts.join(""));
        }
        if (response.stopReason === "pause_turn") continue;
        return;
      }

      // Execute tool calls and collect results
      // Install cancellation results immediately: Stop may allow another user
      // turn or persistence while a vault operation is still in flight.
      let resultBlocks: ContentBlock[] = toolCalls.map(tc => ({
        type: "tool_result", tool_use_id: tc.id,
        content: "Tool execution cancelled before completion.", is_error: true,
      }));
      this.messages.push({ role: "user", content: resultBlocks });

      let askedAloud = "";
      for (const [index, tc] of toolCalls.entries()) {
        if (isStopped()) return;
        callbacks.onToolCall(tc.name!, tc.input!);
        if (isStopped()) return;

        // In a voice turn the question is spoken as the turn's answer instead of waiting in the input.
        const voiceQuestion = this.voiceTurn && tc.name === "ask_user" ? (typeof tc.input?.question === "string" ? tc.input.question.trim() : "") : "";
        if (voiceQuestion) askedAloud = askedAloud ? `${askedAloud}\n\n${voiceQuestion}` : voiceQuestion;
        // A newly discovered rule must reach the model before a write.
        // Rules returned earlier in this same batch have not reached it yet.
        const knownRules = instructionsGiven(afterCompaction(this.messages.slice(0, -1), () => true));
        const initialRules = voiceQuestion
          ? { text: "", sources: [] as string[] }
          : await folderInstructionContext(this.app, toolPaths(this.app, tc.name!, tc.input!), knownRules);
        let folderRules = initialRules.text;
        const instructionSources = initialRules.sources;
        if (isStopped()) return;
        const writes = ["edit_document", "create_file", "rename_file", "delete_file", "set_properties", "edit_canvas"];
        const result = voiceQuestion
          ? { result: VOICE_ASK_RESULT, isError: false, instructionPaths: undefined as string[] | undefined }
          : folderRules && writes.includes(tc.name!)
            ? { result: "No changes made. Read the folder instructions below, then retry the tool if it complies.", isError: true }
            : await executeTool(this.app, tc.name!, tc.input!, callbacks.onAskUser, scope, callbacks.changes, turnSettings.skillsFolder);
        if (result.instructionPaths?.length) {
          const discovered = await folderInstructionContext(this.app, result.instructionPaths, new Set([...knownRules, ...instructionSources]));
          folderRules = [folderRules, discovered.text].filter(Boolean).join("\n\n");
          instructionSources.push(...discovered.sources);
        }
        if (callbacks.changes && !callbacks.changes.canUndo() && !undoBudgetReported) {
          result.result += "\nUndo snapshots exceeded their memory budget. This answer's changes are kept; undo is unavailable for the entire answer.";
          undoBudgetReported = true;
        }
        if (isStopped()) return;
        const instructionOffset = folderRules ? result.result.length : undefined;
        if (folderRules) result.result = `${result.result}\n\n${folderRules}`;
        resultBlocks[index] = {
          type: "tool_result",
          tool_use_id: tc.id,
          content: result.result,
          ...(instructionSources.length ? { instructionSources, instructionOffset } : {}),
          is_error: result.isError,
          ...(result.images?.length ? { images: result.images } : {}),
          ...(result.files?.length ? { files: result.files } : {}),
        };
        this.messages = withoutLargeToolText(this.messages);
        this.pruneToolImages();
        // Pruning can copy this result message. Later calls in the same batch
        // must update its current array, not the superseded result array.
        resultBlocks = this.messages[this.messages.length - 1].content as ContentBlock[];
        result.result = resultBlocks[index].content ?? "";
        debugLog(this.app, "TOOL_CALL", { name: tc.name, input: tc.input, result: result.result, isError: result.isError });
        const { instructionPaths: _paths, ...visibleResult } = result;
        callbacks.onToolResult(tc.name!, displayResult(visibleResult));
        // The spoken reply arrives in the next turn. Later calls in this
        // batch keep their cancellation results and cannot act before it.
        if (voiceQuestion) break;
      }

      if (isStopped()) return;
      // What the user added meanwhile goes with the next request, after the
      // results; without another request (the last step) it runs next instead.
      if (!askedAloud && i + 1 < maxIterations) for (const { text, context } of this.steered.splice(0)) {
        resultBlocks.push({ type: "text", text: `[The user added while you were working:${context?.length ? ` ${voiceTranscriptText(context)}` : ""}] ${text}` });
        callbacks.onSteered?.(text);
      }
      // A question in a voice turn is its answer; the user's reply starts the next turn.
      if (askedAloud) {
        callbacks.onResponse(askedAloud);
        return;
      }
    }

    // If we get here, we hit the iteration limit
    callbacks.onError(
      `Reached maximum iterations (${maxIterations}). The task may be too complex for a single conversation turn.`
    );
  }

  /** Keep completed server operations even when the surrounding response failed. */
  private keepRemoteReceipts(response: UnifiedResponse, callbacks?: AgentCallbacks): void {
    const calls = (response.serverCalls ?? []).filter(call => !call.pending);
    if (callbacks) displayServerCalls(calls, callbacks);
    const content = response.content.filter(block => block.type !== "tool_use");
    // Keep the receipt in both representations: even a partial native replay
    // must retain it after revoking one of its servers.
    const receipts = calls.map(call =>
      `Remote MCP receipt (${call.server}/${call.tool}, ${call.isError ? "error" : "completed"}): ${boundedToolText(call.result, 1000)}`,
    );
    if (callbacks) for (const call of response.serverCalls ?? []) if (call.pending) {
      receipts.push(`Remote MCP operation (${call.server}/${call.tool}): started, outcome unknown. Check the external service before repeating it.`);
    }
    const receipt = boundedToolText(receipts.join("\n"), 8000);
    if (receipt) content.push({ type: "text", text: receipt });
    const replay = response.replay && { ...response.replay, items: response.replay.items.filter(item => item.type !== "tool_use" && item.type !== "function_call") };
    if (replay && receipt) replay.items.push(replay.provider === "anthropic"
      ? { type: "text", text: receipt }
      : { type: "message", role: "assistant", content: [{ type: "output_text", text: receipt, annotations: [] }] });
    this.messages.push({
      role: "assistant", content,
      replay,
    });
    this.messages = withoutLargeToolText(this.messages);
  }

  /** Bound stored tool pixels as well as outgoing requests; user attachments stay. */
  private pruneToolImages(): void {
    const pruned = withoutOldToolImages(this.messages);
    if (pruned.some((message, index) => message !== this.messages[index])) this.messages = pruned;
  }

  /** One request with its own abort controller, watched for a stall after the background. */
  private async send(
    settings: ChatSettings,
    systemPrompt: string,
    isStopped: () => boolean,
    onTextDelta: (text: string) => void,
    onRequestStarted?: (remoteEffectsPossible: boolean) => void | Promise<void>,
  ): Promise<UnifiedResponse> {
    const request = new AbortController();
    this.request = request;
    const unwatch = watchForStall(request);
    let remoteStarted = false;
    try {
      return await sendMessage(settings, this.messages, TOOL_DEFINITIONS, systemPrompt, isStopped,
        { onTextDelta, signal: request.signal, onRequestStarted, onServerTool: () => { remoteStarted = true; } });
    } catch (e) {
      // Aborted, but not by Stop: the watch gave it up.
      if (e instanceof ProviderError && e.remoteEffectsPossible) throw e;
      if (remoteStarted && !(e instanceof ProviderError && e.partialResponse)) throw new StreamCutError("Provider", true);
      if (request.signal.aborted && !isStopped()) {
        throw new Error("No answer arrived after Obsidian came back from the background. Please try again.");
      }
      throw e;
    } finally {
      unwatch();
      if (this.request === request) this.request = null;
    }
  }
}
