import { App } from "obsidian";
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
import { ProviderError } from "../api/errors";
import { sendMessage } from "../api/client";
import { clearOpenAIState } from "../api/openai";
import { clearChatGPTOAuthState } from "../api/chatgpt-oauth";
import { serverToolName } from "../api/mcp";
import { TOOL_DEFINITIONS } from "../tools/registry";
import { executeTool } from "../tools/executor";
import { buildContext } from "./context";
import { folderInstructionContext, instructionsGiven, rootInstructions, toolPaths } from "./instructions";
import { findSkills, skillsPrompt } from "./skills";
import { buildSystemPrompt, buildContextMessage } from "./system-prompt";
import { trimHistory, cutBeforeTurn, editableTurn, newTurnId, withoutOldToolImages, withoutToolAttachments, withoutLargeToolText, boundedToolText, MAX_CONVERSATION_LENGTH } from "./history";
import { debugLog } from "../debug";
import { attachmentBudgetError } from "../files/attachments";
import { RequestBudgetError } from "../api/request-budget";

/**
 * The API history: saving keeps the last 80 messages. Before a turn, a
 * history over 80 messages is cut to the last 60, so it is cut every few
 * turns, not on each; in between it stays the same array and OpenAI can
 * chain to its previous response. Both keep whole user turns, so they
 * round up: a long turn can keep a few more messages.
 */
const KEEP_RECENT = 60;

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
    this.messages = withoutLargeToolText(trimHistory(messages, MAX_CONVERSATION_LENGTH));
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

  trimForRetention(): void {
    const retained = trimHistory(this.messages, MAX_CONVERSATION_LENGTH);
    if (retained !== this.messages) {
      this.messages = retained;
      this.invalidateHistoryCursor();
    }
  }

  /** Nothing in the API history yet. */
  isEmpty(): boolean {
    return this.messages.length === 0;
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
   */
  async run(
    userMessage: string,
    callbacks: AgentCallbacks,
    selection?: SelectionScope | null,
    images: ImageAttachment[] = [],
    turnId: string = newTurnId(),
    mentioned: MentionContext | null = null,
    notes: string[] = [],
    files: FileAttachment[] = []
  ): Promise<void> {
    const version = ++this.runVersion;
    const isStopped = () => version !== this.runVersion;
    // This turn's selection: the tools change only that text of its note (a
    // copy, since its text follows the edits).
    const scope = selection ? { ...selection } : undefined;
    // Keep one provider/model/credential configuration for this entire turn.
    const turnSettings = { ...this.settings, mcpServers: this.settings.mcpServers?.map(server => ({ ...server })) ?? [] };

    // Build context once per user turn and prepend to the user message;
    // the files the message links to come next, the message itself last.
    const context = { ...buildContext(this.app), ...(notes.length ? { notes } : {}) };
    let contextPrefix = mentioned ? `${buildContextMessage(context)}\n\n${mentioned.text}` : buildContextMessage(context);
    images = [...images, ...mentioned?.images ?? []];
    files = [...files, ...mentioned?.files ?? []];
    const budgetError = attachmentBudgetError(images, files);
    if (budgetError) {
      (callbacks.onPreflightRejected ?? callbacks.onError)(budgetError);
      return;
    }
    let instructionSources: string[] = [];
    try {
      const prospective: UnifiedMessage[] = [...this.messages, { role: "user", content: "", turnId }];
      const retained = prospective.length > MAX_CONVERSATION_LENGTH ? trimHistory(prospective, KEEP_RECENT) : this.messages;
      const paths = [...mentioned?.instructionPaths ?? [], ...selection ? [selection.filePath] : []];
      const rules = await folderInstructionContext(this.app, paths, instructionsGiven(retained));
      if (isStopped()) return;
      instructionSources = rules.sources;
      if (rules.text) contextPrefix = `${rules.text}\n\n${contextPrefix}`;
    } catch (e) {
      if (isStopped()) return;
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
    const beforeTurn = this.messages.slice();
    this.messages.push({ role: "user", content, turnId, ...(instructionSources.length ? { instructionSources } : {}) });

    // Prune if conversation is too long
    this.pruneHistory();

    // System prompt is static (cache-friendly): the built-in one, the
    // vault's skills and its AGENTS.md, which rarely change. Read once per turn.
    this.vaultInstructions = await rootInstructions(this.app);
    this.skills = skillsPrompt(findSkills(this.app, turnSettings.skillsFolder));
    const systemPrompt = buildSystemPrompt(this.vaultInstructions, this.skills);

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

    const maxIterations = turnSettings.maxIterations || 20;
    let undoBudgetReported = false;

    for (let i = 0; i < maxIterations; i++) {
      if (isStopped()) return;
      // Revoking/changing a server applies to the next request, including
      // another step in this turn. An already-sent remote call cannot be recalled.
      turnSettings.mcpServers = this.settings.mcpServers?.map(server => ({ ...server })) ?? [];

      callbacks.onThinking();
      if (isStopped()) return;

      let response;
      try {
        response = await sendMessage(
          turnSettings,
          this.messages,
          TOOL_DEFINITIONS,
          systemPrompt,
          isStopped
        );
      } catch (caughtError) {
        let e = caughtError;
        if (isStopped()) return;
        if (i > 0 && e instanceof RequestBudgetError) {
          const reduced = withoutLargeToolText(withoutToolAttachments(this.messages));
          if (reduced !== this.messages) {
            this.messages = reduced;
            clearOpenAIState();
            clearChatGPTOAuthState();
            try {
              response = await sendMessage(turnSettings, this.messages, TOOL_DEFINITIONS, systemPrompt, isStopped);
            } catch (retryError) { e = retryError; }
            if (isStopped()) return;
          }
        }
        if (!response) {
          const msg = e instanceof Error ? e.message : String(e);
          if (e instanceof ProviderError && e.partialResponse) {
            this.keepRemoteReceipts(e.partialResponse, callbacks);
            const partialText = e.partialResponse.content.filter(block => block.type === "text").map(block => block.text).join("");
            if (partialText) callbacks.onResponse(partialText);
          }
          debugLog(this.app, "API_ERROR", { error: msg, model: this.settings.model, provider: this.settings.provider });
          if (i === 0 && e instanceof RequestBudgetError) {
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
      });

      if (isStopped()) return;

      // Tools the provider called on MCP servers: shown as steps, not run here.
      for (const call of response.serverCalls ?? []) {
        if (call.pending) continue;
        callbacks.onToolCall(serverToolName(call), call.input);
        callbacks.onToolResult(serverToolName(call), { result: boundedToolText(call.result), isError: call.isError });
      }

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
      this.messages.push({ role: "assistant", content: response.content, replay: response.replay });
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

      for (const [index, tc] of toolCalls.entries()) {
        if (isStopped()) return;
        callbacks.onToolCall(tc.name!, tc.input!);
        if (isStopped()) return;

        // A newly discovered rule must reach the model before a write.
        // Rules returned earlier in this same batch have not reached it yet.
        const knownRules = instructionsGiven(this.messages.slice(0, -1));
        const initialRules = await folderInstructionContext(this.app, toolPaths(this.app, tc.name!, tc.input!), knownRules);
        let folderRules = initialRules.text;
        const instructionSources = initialRules.sources;
        if (isStopped()) return;
        const writes = ["edit_document", "create_file", "rename_file", "delete_file", "set_properties", "edit_canvas"];
        const result = folderRules && writes.includes(tc.name!)
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
      }

      if (isStopped()) return;
    }

    // If we get here, we hit the iteration limit
    callbacks.onError(
      `Reached maximum iterations (${maxIterations}). The task may be too complex for a single conversation turn.`
    );
  }

  /** Keep completed server operations even when the surrounding response failed. */
  private keepRemoteReceipts(response: UnifiedResponse, callbacks?: AgentCallbacks): void {
    const calls = (response.serverCalls ?? []).filter(call => !call.pending);
    if (callbacks) for (const call of calls) {
      callbacks.onToolCall(serverToolName(call), call.input);
      callbacks.onToolResult(serverToolName(call), { result: boundedToolText(call.result), isError: call.isError });
    }
    const content = response.content.filter(block => block.type !== "tool_use");
    // Keep the receipt in both representations: even a partial native replay
    // must retain it after revoking one of its servers.
    const receipt = calls.length ? boundedToolText(calls.map(call =>
      `Remote MCP receipt (${call.server}/${call.tool}, ${call.isError ? "error" : "completed"}): ${boundedToolText(call.result, 1000)}`,
    ).join("\n"), 8000) : "";
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

  /** Drop oldest messages when conversation gets too long, keeping recent context */
  private pruneHistory(): void {
    if (this.messages.length > MAX_CONVERSATION_LENGTH) {
      this.messages = trimHistory(this.messages, KEEP_RECENT);
    }
    this.pruneToolImages();
  }
}
