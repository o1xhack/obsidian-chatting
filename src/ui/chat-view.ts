import { ItemView, WorkspaceLeaf, Notice, type App } from "obsidian";
import { mount, unmount } from "svelte";
import type { Component } from "svelte";
import type ChatPlugin from "../main";
import ChatContainer from "./ChatContainer.svelte";
import type { ToolResult, SelectionScope, ImageAttachment } from "../types";
import { getModelDisplayName } from "../settings";

export const VIEW_TYPE_CHAT = "ochatting-view";

interface ChatContainerProps {
  app: App;
  component: ObsidianChatView;
  provider: string;
  model: string;
  onSend: (text: string, selection: SelectionScope | null, images: ImageAttachment[]) => void;
  onClear: () => void;
  onStop: () => void;
}

interface ChatContainerApi extends Record<string, unknown> {
  addUserMessage(text: string, images?: ImageAttachment[]): void;
  addAssistantMessage(text: string): void;
  addToolCall(name: string, input: Record<string, unknown>): number;
  updateToolResult(msgId: number, name: string, result: ToolResult): void;
  addError(text: string): void;
  showThinking(): void;
  hideThinking(): void;
  showAskUser(question: string): Promise<string>;
  setInputEnabled(enabled: boolean): void;
  clearMessages(): void;
  focus(): void;
  setModel(name: string): void;
  setSelection(selection: SelectionScope): void;
  getSelection(): SelectionScope | null;
}

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

  constructor(leaf: WorkspaceLeaf, plugin: ChatPlugin) {
    super(leaf);
    this.plugin = plugin;
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
        model: getModelDisplayName(this.plugin.settings.provider, this.plugin.settings.model),
        onSend: (text: string, selection: SelectionScope | null, images: ImageAttachment[]) => {
          void this.handleUserMessage(text, selection, images);
        },
        onClear: () => this.handleClear(),
        onStop: () => this.handleStop(),
      },
    });

    // Replay chat history into the UI
    for (const msg of this.plugin.chatHistory) {
      switch (msg.type) {
        case "user":
          this.chatContainer.addUserMessage(msg.text!, msg.images);
          break;
        case "assistant":
          this.chatContainer.addAssistantMessage(msg.text!);
          break;
        case "tool-result":
          if (msg.toolName && msg.toolResult) {
            const id = this.chatContainer.addToolCall(msg.toolName, msg.toolInput || {});
            this.chatContainer.updateToolResult(id, msg.toolName, msg.toolResult);
          }
          break;
        case "error":
          this.chatContainer.addError(msg.text!);
          break;
      }
    }

    this.chatContainer.focus();
  }

  async onClose(): Promise<void> {
    this.plugin.agent.abort();
    if (this.chatContainer) {
      await unmount(this.chatContainer);
      this.chatContainer = undefined;
    }
  }

  /** Export the full transcript for debugging */
  getTranscript(): string {
    return this.plugin.agent.exportTranscript();
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

  /** Clear conversation */
  clearConversation(): void {
    this.handleClear();
  }

  private async handleUserMessage(
    text: string,
    selection: SelectionScope | null,
    images: ImageAttachment[] = []
  ): Promise<void> {
    if (this.running) {
      new Notice("Please wait for the current response to complete.");
      return;
    }

    const chat = this.chatContainer!;
    const history = this.plugin.chatHistory;

    this.running = true;
    chat.addUserMessage(text, images);
    history.push({ type: "user", text, images });
    chat.setInputEnabled(false);

    const toolCallIds = new Map<string, number>();

    try {
      await this.plugin.agent.run(text, {
        onThinking: () => {
          chat.showThinking();
        },
        onToolCall: (name, input) => {
          chat.hideThinking();
          if (name === "ask_user") return;
          const msgId = chat.addToolCall(name, input);
          toolCallIds.set(`latest-${name}`, msgId);
        },
        onToolResult: (name, result: ToolResult) => {
          if (name === "ask_user") return;
          const msgId = toolCallIds.get(`latest-${name}`);
          if (msgId !== undefined) {
            chat.updateToolResult(msgId, name, result);
          }
          history.push({ type: "tool-result", toolName: name, toolInput: {}, toolResult: result });
        },
        onResponse: (text) => {
          chat.hideThinking();
          chat.addAssistantMessage(text);
          history.push({ type: "assistant", text });
        },
        onAskUser: async (question) => {
          chat.hideThinking();
          chat.setInputEnabled(true);
          const answer = await chat.showAskUser(question);
          chat.setInputEnabled(false);
          return answer;
        },
        onError: (error) => {
          chat.hideThinking();
          chat.addError(error);
          history.push({ type: "error", text: error });
        },
      }, selection, images);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      chat.addError(`Unexpected error: ${msg}`);
      history.push({ type: "error", text: `Unexpected error: ${msg}` });
    } finally {
      this.running = false;
      chat.setInputEnabled(true);
      chat.focus();
      // Persist after each turn
      void this.plugin.saveChatHistory();
    }
  }

  private handleStop(): void {
    this.plugin.agent.abort();
    this.running = false;
    const chat = this.chatContainer;
    if (chat) {
      chat.hideThinking();
      chat.setInputEnabled(true);
      chat.focus();
    }
    void this.plugin.saveChatHistory();
  }

  private handleClear(): void {
    this.plugin.agent.abort();
    this.plugin.agent.clear();
    this.plugin.chatHistory = [];
    this.chatContainer?.clearMessages();
    this.running = false;
    this.chatContainer?.setInputEnabled(true);
    // Clear persisted state
    void this.plugin.saveChatHistory();
  }
}
