import type { UnifiedMessage } from "../types";

function startsUserTurn(message: UnifiedMessage): boolean {
  return message.role === "user" && (typeof message.content === "string" ||
    message.content.some(block => block.type === "text" || block.type === "image"));
}

/** Keep whole user turns so pruning/persistence cannot orphan tool results. */
export function trimHistory(messages: UnifiedMessage[], limit: number): UnifiedMessage[] {
  const firstTurn = messages.findIndex(startsUserTurn);
  if (firstTurn < 0) return [];
  let start = firstTurn;
  const cutoff = Math.max(0, messages.length - limit);
  for (let index = firstTurn; index <= cutoff; index++) {
    if (startsUserTurn(messages[index])) start = index;
  }
  return start === 0 ? messages : messages.slice(start);
}
