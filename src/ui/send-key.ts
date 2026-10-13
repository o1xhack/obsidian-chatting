/**
 * Whether a key press sends (the chat input) or saves (the edit box of a
 * sent message), following the "Enter sends message" setting. On: Enter,
 * Shift+Enter is a new line. Off: Ctrl/Cmd+Enter, Enter is a new line.
 * Never while an IME composes (the callers also skip Safari's keyCode 229).
 */
export function isSendKey(e: Pick<KeyboardEvent, "key" | "shiftKey" | "ctrlKey" | "metaKey" | "isComposing">, enterSends: boolean): boolean {
  if (e.key !== "Enter" || e.isComposing) return false;
  return enterSends ? !e.shiftKey : e.ctrlKey || e.metaKey;
}
