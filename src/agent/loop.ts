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
} from "../types";
import { sendMessage } from "../api/client";
import { StreamCutError } from "../api/errors";
import { lastChunkAt } from "../api/stream";
import { clearOpenAIState } from "../api/openai";
import { chatgptCompacts, clearChatGPTOAuthState } from "../api/chatgpt-oauth";
import { catalogModel, loadModelDetails, type ModelOption } from "../api/model-catalog";
import { serverToolName } from "../api/mcp";
import { TOOL_DEFINITIONS } from "../tools/registry";
import { executeTool } from "../tools/executor";
import { buildContext } from "./context";
import { folderInstructions, instructionsGiven, rootInstructions, toolPaths } from "./instructions";
import { findSkills, skillsPrompt } from "./skills";
import { buildSystemPrompt, buildContextMessage } from "./system-prompt";
import { trimHistory, cutBeforeTurn, editableTurn, newTurnId, MAX_CONVERSATION_LENGTH } from "./history";
import { debugLog } from "../debug";
import { appLifecycle } from "../platform/lifecycle";
import { compactThreshold, summaryMessage } from "./compaction";
import { SUMMARY_SYSTEM_PROMPT, isContextOverflow, summaryRequest } from "./summary";

/** The turn ID of a summary message (it starts its own turn, with no visible entry). */
function summaryTurnId(): string {
  return `summary-${newTurnId()}`;
}

/**
 * The API history: saving keeps the last 80 messages. Before a turn, a
 * history over 80 messages is cut to the last 60, so it is cut every few
 * turns, not on each; in between it stays the same array and OpenAI can
 * chain to its previous response. Both keep whole user turns, so they
 * round up: a long turn can keep a few more messages.
 */
const KEEP_RECENT = 60;

/** Sending a request again (a cut-off stream, back from the background); tests shorten the wait. */
export const RESUME = {
  /** Requests sent again per turn at most; after that the error shows. */
  perTurn: 2,
  /**
   * Back in the foreground, an open request is given up after this long
   * (ms) without data, counted from the return or its last data.
   */
  stallMs: 10_000,
};

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
    const quietMs = Date.now() - Math.max(backAt, lastChunkAt(request.signal) ?? 0);
    if (quietMs >= RESUME.stallMs) request.abort();
    else timer = window.setTimeout(check, RESUME.stallMs - quietMs);
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
    result: `${result.result}\n\n[${what} sent to the model]`,
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
  private steered: string[] = [];
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
   * arrives after the last step is returned by `takeSteered()`.
   */
  steer(text: string): boolean {
    if (!this.loopVersion || this.loopVersion !== this.runVersion) return false;
    this.steered.push(text);
    debugLog(this.app, "STEER", { text });
    return true;
  }

  /** Added messages the finished turn didn't get to; they need a turn of their own. */
  takeSteered(): string[] {
    return this.steered.splice(0);
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

  /** Turn `turnId` can be edited or answered again (the API history still holds it). */
  canEditTurn(turnId: string): boolean {
    return editableTurn(this.messages, turnId);
  }

  /** Export API messages for persistence */
  exportMessages(limit = MAX_CONVERSATION_LENGTH): UnifiedMessage[] {
    return trimHistory(this.messages, limit);
  }

  /** Restore API messages from persistence, as many as saving keeps */
  importMessages(messages: UnifiedMessage[]): void {
    this.messages = trimHistory(messages, MAX_CONVERSATION_LENGTH);
    clearOpenAIState();
    clearChatGPTOAuthState();
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
  async compact(): Promise<boolean> {
    if (this.messages.length === 0 || this.loopVersion) return false;
    const version = ++this.runVersion;
    const isStopped = () => version !== this.runVersion;
    const summary = await this.summarize({ ...this.settings }, this.messages, isStopped);
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
      const index = this.messages.map((message) => !!message.compaction).lastIndexOf(true);
      const marker = this.messages[index];
      const replay = marker?.replay;
      const replayable = replay?.provider === settings.provider && (!replay.model || replay.model === settings.model);
      if (marker?.compaction && !marker.compaction.summary && !replayable && index > 0) {
        marker.compaction = { summary: await this.summarize(settings, this.messages.slice(0, index), isStopped) };
        debugLog(this.app, "COMPACTED", { reason: "provider switch" });
      }
      const option = catalogModel(settings.provider, settings.model);
      const threshold = compactThreshold(settings.provider, option);
      if (!isStopped() && threshold && contextTokens >= threshold && !this.compactsNatively(settings, option) && this.messages.length) {
        const summary = await this.summarize(settings, this.messages, isStopped);
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
      const summary = await this.summarize(settings, this.messages.slice(0, start), isStopped);
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

  /** A summary of `messages` by the provider (a transcript; no tools, web search or MCP servers); Stop cancels it. */
  private async summarize(settings: ChatSettings, messages: UnifiedMessage[], isStopped: () => boolean): Promise<string> {
    const window = catalogModel(settings.provider, settings.model)?.contextWindow;
    const request = new AbortController();
    this.request = request;
    try {
      const response = await sendMessage({ ...settings, enableWebSearch: false, mcpServers: [] },
        [{ role: "user", content: summaryRequest(messages, window) }], [], SUMMARY_SYSTEM_PROMPT, isStopped, { signal: request.signal });
      const text = response.content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("").trim();
      if (!text) throw new Error("The summary came back empty.");
      return text;
    } finally {
      if (this.request === request) this.request = null;
    }
  }

  /** Nothing in the API history yet. */
  isEmpty(): boolean {
    return this.messages.length === 0;
  }

  /** The history ends in a user message or tool results: the model hasn't answered them. */
  owesAnswer(): boolean {
    return this.messages.at(-1)?.role === "user";
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
    contextTokens = 0
  ): Promise<void> {
    const version = ++this.runVersion;
    // This turn's selection: the tools change only that text of its note (a
    // copy, since its text follows the edits).
    const scope = selection ? { ...selection } : undefined;
    // Keep one provider/model/credential configuration for this entire turn.
    const turnSettings = { ...this.settings };
    // A summary first where the provider can't compact.
    await this.prepareContext(turnSettings, contextTokens, callbacks, () => version !== this.runVersion);
    if (version !== this.runVersion) return;

    // Build context once per user turn and prepend to the user message;
    // the files the message links to come next, the message itself last.
    const context = { ...buildContext(this.app), ...(notes.length ? { notes } : {}) };
    const contextPrefix = mentioned ? `${buildContextMessage(context)}\n\n${mentioned.text}` : buildContextMessage(context);
    images = [...images, ...mentioned?.images ?? []];
    files = [...files, ...mentioned?.files ?? []];

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
    this.messages.push({ role: "user", content, turnId });

    // Prune if conversation is too long
    this.pruneHistory();

    debugLog(this.app, "USER_MESSAGE", {
      userMessage,
      // As the model gets it: the context lines first.
      sent: fullMessage,
      model: turnSettings.model,
      provider: turnSettings.provider,
      hasSelection: !!selection,
      imageCount: images.length,
      imageNames: images.map((image) => image.fileName),
      fileNames: files.map((file) => file.fileName),
    });

    await this.loop(version, callbacks, turnSettings, scope);
  }

  /**
   * Continue the turn the history ends in, cut off before the model
   * answered (Obsidian was ended in the background): the loop runs on the
   * history as it is, without a new user message. Tool results already
   * there are sent, not run again. A selection isn't saved, so the
   * continued turn has none.
   */
  async continueTurn(callbacks: AgentCallbacks): Promise<void> {
    const version = ++this.runVersion;
    if (!this.owesAnswer()) return;
    debugLog(this.app, "CONTINUE_TURN", { messages: this.messages.length });
    const turnSettings = { ...this.settings };
    await this.prepareContext(turnSettings, 0, callbacks, () => version !== this.runVersion);
    if (version !== this.runVersion) return;
    await this.loop(version, callbacks, turnSettings, undefined);
  }

  /** The agentic loop on the current history, for run `version`; `steer()` adds to it meanwhile. */
  private async loop(
    version: number,
    callbacks: AgentCallbacks,
    turnSettings: ChatSettings,
    scope: SelectionScope | undefined
  ): Promise<void> {
    this.loopVersion = version;
    try {
      await this.steps(version, callbacks, turnSettings, scope);
    } finally {
      if (this.loopVersion === version) this.loopVersion = 0;
    }
  }

  private async steps(
    version: number,
    callbacks: AgentCallbacks,
    turnSettings: ChatSettings,
    scope: SelectionScope | undefined
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
          response = await this.send(turnSettings, systemPrompt, isStopped, onTextDelta);
        } catch (e) {
          if (isStopped()) return;
          if (!overflowCompacted && isContextOverflow(e)) {
            overflowCompacted = true;
            callbacks.onThinking();
            if (await this.compactForOverflow(turnSettings, callbacks, isStopped)) continue;
            if (isStopped()) return;
          }
          const msg = e instanceof Error ? e.message : String(e);
          // The stream was cut off (a dropped connection, no provider error),
          // or the request failed or was given up while Obsidian was in the
          // background: send the same request again, once Obsidian is
          // visible. The history holds every completed step, so nothing runs twice.
          const background = appLifecycle.hiddenSince(startedAt);
          if (resends < RESUME.perTurn && (e instanceof StreamCutError || background)) {
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
          debugLog(this.app, "API_ERROR", { error: msg, model: this.settings.model, provider: this.settings.provider });
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
        if (i === 0) await loadModelDetails(turnSettings.modelCatalog, turnSettings.provider, turnSettings.apiKey, turnSettings.model);
        callbacks.onUsage?.(response.usage, { provider: turnSettings.provider, model: turnSettings.model, turnStart: i === 0 });
      }

      if (isStopped()) return;

      // Tools the provider called on MCP servers: shown as steps, not run here.
      for (const call of response.serverCalls ?? []) {
        callbacks.onToolCall(serverToolName(call), call.input);
        callbacks.onToolResult(serverToolName(call), { result: call.result, isError: call.isError });
      }

      // Do not execute or persist truncated tool arguments as a completed call.
      if (response.stopReason === "max_tokens") {
        const text = response.content.filter(block => block.type === "text").map(block => block.text).join("");
        if (text) callbacks.onResponse(text);
        callbacks.onError("The response reached its token limit before completing. Please try a smaller request.");
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
      const resultBlocks: ContentBlock[] = toolCalls.map(tc => ({
        type: "tool_result", tool_use_id: tc.id,
        content: "Tool execution cancelled before completion.", is_error: true,
      }));
      this.messages.push({ role: "user", content: resultBlocks });

      for (const [index, tc] of toolCalls.entries()) {
        if (isStopped()) return;
        callbacks.onToolCall(tc.name!, tc.input!);
        if (isStopped()) return;

        const result = await executeTool(
          this.app,
          tc.name!,
          tc.input!,
          callbacks.onAskUser,
          scope,
          callbacks.changes,
          turnSettings.skillsFolder
        );
        debugLog(this.app, "TOOL_CALL", { name: tc.name, input: tc.input, result: result.result, isError: result.isError });

        if (isStopped()) return;
        // A folder's own AGENTS.md comes with the first result touching a file there.
        const folderRules = await folderInstructions(this.app, toolPaths(this.app, tc.name!, tc.input!), instructionsGiven(this.messages));
        if (isStopped()) return;
        if (folderRules) result.result = `${result.result}\n\n${folderRules}`;
        resultBlocks[index] = {
          type: "tool_result",
          tool_use_id: tc.id,
          content: result.result,
          is_error: result.isError,
          ...(result.images?.length ? { images: result.images } : {}),
          ...(result.files?.length ? { files: result.files } : {}),
        };
        callbacks.onToolResult(tc.name!, displayResult(result));
      }

      if (isStopped()) return;
      // What the user added meanwhile goes with the next request, after the results.
      for (const text of this.steered.splice(0)) {
        resultBlocks.push({ type: "text", text: `[The user added while you were working:] ${text}` });
        callbacks.onSteered?.(text);
      }
    }

    // If we get here, we hit the iteration limit
    callbacks.onError(
      `Reached maximum iterations (${maxIterations}). The task may be too complex for a single conversation turn.`
    );
  }

  /** One request with its own abort controller, watched for a stall after the background. */
  private async send(
    settings: ChatSettings,
    systemPrompt: string,
    isStopped: () => boolean,
    onTextDelta: (text: string) => void,
  ): Promise<UnifiedResponse> {
    const request = new AbortController();
    this.request = request;
    const unwatch = watchForStall(request);
    try {
      return await sendMessage(settings, this.messages, TOOL_DEFINITIONS, systemPrompt, isStopped,
        { onTextDelta, signal: request.signal });
    } catch (e) {
      // Aborted, but not by Stop: the watch gave it up.
      if (request.signal.aborted && !isStopped()) {
        throw new Error("No answer arrived after Obsidian came back from the background. Please try again.");
      }
      throw e;
    } finally {
      unwatch();
      if (this.request === request) this.request = null;
    }
  }

  /** Drop oldest messages when conversation gets too long, keeping recent context */
  private pruneHistory(): void {
    if (this.messages.length > MAX_CONVERSATION_LENGTH) {
      this.messages = trimHistory(this.messages, KEEP_RECENT);
    }
  }
}
