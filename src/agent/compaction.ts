import type { ModelOption } from "../api/model-catalog";
import type { ChatSettings, Provider, UnifiedMessage } from "../types";

/** How a readable summary starts when it stands in for the earlier conversation. */
export const SUMMARY_PREFIX = "[Summary of the earlier part of this conversation, which is no longer in your context:]";

/** The user message that carries a summary. */
export function summaryMessage(summary: string, turnId?: string): UnifiedMessage {
  return { role: "user", content: `${SUMMARY_PREFIX}\n\n${summary}`, ...(turnId ? { turnId } : {}) };
}

/**
 * What a request sends after a compaction: from the last message that
 * compacted the context on. The provider replays its native item itself
 * (`replayable`); otherwise its readable summary stands first. A compaction
 * without one (OpenAI's is encrypted) leaves the whole history: the agent
 * loop writes a summary before the turn (`AgentLoop.prepareContext`).
 */
export function afterCompaction(messages: UnifiedMessage[], replayable: (message: UnifiedMessage) => boolean): UnifiedMessage[] {
  for (let i = messages.length - 1; i >= 0; i--) {
    const compaction = messages[i].compaction;
    if (!compaction) continue;
    if (replayable(messages[i])) return messages.slice(i);
    if (compaction.summary) return [summaryMessage(compaction.summary), ...messages.slice(i)];
    return messages;
  }
  return messages;
}

/**
 * When a conversation's context gets compacted by default: at 80 % of the
 * model's window, leaving room for the answer and the next steps, as Codex
 * compacts before the window is full. The ChatGPT catalog names its own
 * point (`auto_compact_token_limit`); Anthropic's trigger is at least
 * 50,000 tokens. Undefined when the window is unknown.
 */
export const COMPACT_SHARE = 0.8;
export const ANTHROPIC_MIN_TRIGGER = 50000;
/** The lowest compaction point the setting offers, as Anthropic's minimum. */
export const MIN_COMPACT_TOKENS = 50000;

/** The compaction point setting. */
export type CompactionPoint = Partial<Pick<ChatSettings, "compactPercent" | "compactTokens">>;

/**
 * When a conversation's context gets compacted: the setting's share of the
 * model's window, not below `MIN_COMPACT_TOKENS` (or the default point
 * where that is lower); for a model whose window is unknown the setting's
 * token number. Otherwise the default point.
 */
export function compactThreshold(provider: Provider, option: ModelOption | undefined, point: CompactionPoint = {}): number | undefined {
  const fallback = defaultCompactThreshold(provider, option);
  let threshold = fallback;
  if (option?.contextWindow) {
    if (point.compactPercent) {
      const floor = Math.min(MIN_COMPACT_TOKENS, fallback ?? MIN_COMPACT_TOKENS);
      threshold = Math.max(floor, Math.floor(option.contextWindow * point.compactPercent / 100));
    }
  } else if (point.compactTokens) {
    threshold = point.compactTokens;
  }
  return threshold !== undefined && provider === "anthropic" ? Math.max(ANTHROPIC_MIN_TRIGGER, threshold) : threshold;
}

/** The default compaction point. */
export function defaultCompactThreshold(provider: Provider, option: ModelOption | undefined): number | undefined {
  if (!option) return undefined;
  if (provider === "chatgpt-oauth" && option.autoCompactTokens) {
    return option.contextWindow ? Math.min(option.autoCompactTokens, option.contextWindow) : option.autoCompactTokens;
  }
  if (!option.contextWindow) return undefined;
  const threshold = Math.floor(option.contextWindow * COMPACT_SHARE);
  return provider === "anthropic" ? Math.max(ANTHROPIC_MIN_TRIGGER, threshold) : threshold;
}
