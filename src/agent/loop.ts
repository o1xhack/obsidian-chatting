import { App } from "obsidian";
import type {
  ChatSettings,
  UnifiedMessage,
  ContentBlock,
  AgentCallbacks,
  SelectionScope,
  ImageAttachment,
} from "../types";
import { sendMessage } from "../api/client";
import { clearOpenAIState } from "../api/openai";
import { clearChatGPTOAuthState } from "../api/chatgpt-oauth";
import { TOOL_DEFINITIONS } from "../tools/registry";
import { executeTool } from "../tools/executor";
import { buildContext } from "./context";
import { buildSystemPrompt, buildContextMessage } from "./system-prompt";
import { trimHistory } from "./history";

const MAX_CONVERSATION_LENGTH = 50;
const KEEP_RECENT = 40;

// Debug logging: writes transcript to the vault's plugin config folder
const DEBUG = false;

function debugLog(app: App, label: string, data: unknown): void {
  if (!DEBUG) return;
  try {
    const timestamp = new Date().toISOString();
    const entry = `\n--- ${label} [${timestamp}] ---\n${JSON.stringify(data, null, 2)}\n`;
    // Use the adapter to write into the current vault config folder.
    void app.vault.adapter.append(
      `${app.vault.configDir}/plugins/chatting-with-ai/debug.log`,
      entry
    );
  } catch {
    // Debug logging should never break the app
  }
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
  private aborted = false;
  private runVersion = 0;

  constructor(app: App, settings: ChatSettings) {
    this.app = app;
    this.settings = settings;
  }

  /** Abort a running loop (e.g. user navigates away) */
  abort(): void {
    this.aborted = true;
    this.runVersion++;
  }

  /** Clear conversation history */
  clear(): void {
    this.runVersion++;
    this.messages = [];
    this.aborted = false;
    clearOpenAIState();
    clearChatGPTOAuthState();
  }

  /** Export API messages for persistence */
  exportMessages(limit = 80): UnifiedMessage[] {
    return trimHistory(this.messages, limit);
  }

  /** Restore API messages from persistence */
  importMessages(messages: UnifiedMessage[]): void {
    this.messages = trimHistory(messages, KEEP_RECENT);
    clearOpenAIState();
    clearChatGPTOAuthState();
  }

  /** Export the full conversation as a readable markdown transcript */
  exportTranscript(): string {
    const systemPrompt = buildSystemPrompt();

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
          }
        }
      }
    }

    return parts.join("\n");
  }

  /** Run one user turn through the agentic loop */
  async run(
    userMessage: string,
    callbacks: AgentCallbacks,
    selection?: SelectionScope | null,
    images: ImageAttachment[] = []
  ): Promise<void> {
    this.aborted = false;
    const version = ++this.runVersion;
    const isStopped = () => this.aborted || version !== this.runVersion;
    // Keep one provider/model/credential configuration for this entire turn.
    const turnSettings = { ...this.settings };

    // Build context once per user turn and prepend to the user message
    const context = buildContext(this.app);
    const contextPrefix = buildContextMessage(context);

    // If there's a selection, inject it as scoped context
    let fullMessage: string;
    if (selection) {
      fullMessage = [
        contextPrefix,
        "",
        `[Selection scope: The user has selected text in ${selection.filePath}. Work only within this selection. When using edit_document, use find_replace with text from within this selection. Do not modify text outside the selection.]`,
        "",
        `Selected text:`,
        `> ${selection.text}`,
        "",
        userMessage,
      ].join("\n");
    } else {
      fullMessage = `${contextPrefix}\n\n${userMessage}`;
    }

    const content: string | ContentBlock[] = images.length > 0
      ? [
          ...images.map((image): ContentBlock => ({ type: "image", image })),
          { type: "text", text: fullMessage },
        ]
      : fullMessage;
    this.messages.push({ role: "user", content });

    // Prune if conversation is too long
    this.pruneHistory();

    // System prompt is static (cache-friendly). Built once, identical every call.
    const systemPrompt = buildSystemPrompt();

    debugLog(this.app, "USER_MESSAGE", {
      userMessage,
      hasSelection: !!selection,
      imageCount: images.length,
      imageNames: images.map((image) => image.fileName),
    });

    const maxIterations = turnSettings.maxIterations || 20;

    for (let i = 0; i < maxIterations; i++) {
      if (isStopped()) return;

      callbacks.onThinking();
      if (isStopped()) return;

      let response;
      try {
        response = await sendMessage(
          turnSettings,
          this.messages,
          TOOL_DEFINITIONS,
          systemPrompt
        );
      } catch (e) {
        if (isStopped()) return;
        const msg = e instanceof Error ? e.message : String(e);
        debugLog(this.app, "API_ERROR", { error: msg, model: this.settings.model, provider: this.settings.provider });
        callbacks.onError(msg);
        return;
      }

      debugLog(this.app, "API_RESPONSE", { stopReason: response.stopReason, contentTypes: response.content.map(b => b.type), usage: response.usage });

      if (isStopped()) return;

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
      this.messages.push({ role: "assistant", content: response.content, replay: response.replay });

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
          callbacks.onAskUser
        );

        if (isStopped()) return;
        resultBlocks[index] = {
          type: "tool_result",
          tool_use_id: tc.id,
          content: result.result,
          is_error: result.isError,
        };
        callbacks.onToolResult(tc.name!, result);
      }

      if (isStopped()) return;
    }

    // If we get here, we hit the iteration limit
    callbacks.onError(
      `Reached maximum iterations (${maxIterations}). The task may be too complex for a single conversation turn.`
    );
  }

  /** Drop oldest messages when conversation gets too long, keeping recent context */
  private pruneHistory(): void {
    if (this.messages.length > MAX_CONVERSATION_LENGTH) {
      this.messages = trimHistory(this.messages, KEEP_RECENT);
    }
  }
}
