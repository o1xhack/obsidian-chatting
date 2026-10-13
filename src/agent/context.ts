import { App } from "obsidian";
import type { ConversationContext, VoiceTurn } from "../types";

/**
 * Builds a snapshot of the current workspace context.
 * Refreshed each turn; it goes into the user message. `voice` marks a
 * turn from a voice conversation, whose answer will be spoken;
 * `voiceTranscript` is what was said there since the last request.
 */
export function buildContext(app: App, voice = false, voiceTranscript: VoiceTurn[] = []): ConversationContext {
  const activeFile = app.workspace.getActiveFile();
  let selection: string | null = null;

  // Get selection from active editor
  const editor = app.workspace.activeEditor?.editor;
  if (editor) {
    const sel = editor.getSelection();
    if (sel && sel.length > 0) {
      selection = sel;
    }
  }

  return {
    activeFile: activeFile?.path ?? null,
    selection,
    vaultName: app.vault.getName(),
    fileCount: app.vault.getMarkdownFiles().length,
    ...(voice ? { voice: true } : {}),
    ...(voiceTranscript.length ? { voiceTranscript } : {}),
  };
}
