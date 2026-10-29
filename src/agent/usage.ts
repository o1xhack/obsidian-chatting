import type { ModelPricing } from "../api/model-catalog";
import type { TokenUsage } from "../types";

/**
 * What a conversation used: the context of its last request (for the ring
 * in the chat header), the tokens of all its requests, and what they cost,
 * as estimated from the provider's prices. Saved with the conversation.
 */
export interface ConversationUsage {
  /** Tokens of the last request: its input and its answer (the next request starts from there). */
  contextTokens: number;
  /** All tokens of the chat's requests: input (cached included) and output (compaction passes included). */
  inputTokens: number;
  outputTokens: number;
  /** The model and provider of that request. */
  model: string;
  provider: string;
  /** Estimated cost of all priced requests in USD. */
  costUsd: number;
  /** Requests without a price (unknown, or the ChatGPT plan): the cost leaves them out. */
  unpricedRequests: number;
  /** Estimated cost of the last turn's requests in USD (none: not priced). */
  lastTurnCostUsd?: number;
}

const MILLION = 1_000_000;

/**
 * A request's cost in USD from its usage and the model's prices per
 * million tokens: uncached input, cache reads and writes, output, and a
 * compaction pass. Undefined without prices. Leaves out long-context
 * surcharges and discounts (an estimate).
 */
export function requestCost(usage: TokenUsage, pricing: ModelPricing | undefined): number | undefined {
  if (!pricing) return undefined;
  const cached = usage.cachedInputTokens ?? 0;
  const written = usage.cacheWriteTokens ?? 0;
  const uncached = Math.max(0, usage.inputTokens - cached - written);
  return (
    uncached * pricing.input +
    cached * (pricing.cachedInput ?? pricing.input) +
    written * (pricing.cacheWrite ?? pricing.input) +
    usage.outputTokens * pricing.output +
    (usage.compactionInputTokens ?? 0) * pricing.input +
    (usage.compactionOutputTokens ?? 0) * pricing.output
  ) / MILLION;
}

/** The conversation's usage after one more request. `turnStart`: the first request of a turn. */
export function addRequest(
  previous: ConversationUsage | undefined,
  usage: TokenUsage,
  request: { model: string; provider: string; pricing?: ModelPricing; turnStart: boolean },
): ConversationUsage {
  const cost = requestCost(usage, request.pricing);
  const turnBefore = request.turnStart ? undefined : previous?.lastTurnCostUsd;
  return {
    contextTokens: usage.inputTokens + usage.outputTokens,
    inputTokens: (previous?.inputTokens ?? 0) + usage.inputTokens + (usage.compactionInputTokens ?? 0),
    outputTokens: (previous?.outputTokens ?? 0) + usage.outputTokens + (usage.compactionOutputTokens ?? 0),
    model: request.model,
    provider: request.provider,
    costUsd: (previous?.costUsd ?? 0) + (cost ?? 0),
    unpricedRequests: (previous?.unpricedRequests ?? 0) + (cost === undefined ? 1 : 0),
    ...(cost !== undefined ? { lastTurnCostUsd: (turnBefore ?? 0) + cost } : {}),
  };
}

/** "$0.42", "<$0.01". */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** "45.2k", "1.1M". */
/**
 * How full the context ring is (0 to 1): full means compaction, so the
 * share of the compaction point, or of the model's window where no point is
 * known. Undefined without either.
 */
export function contextShare(contextTokens: number, compactAt: number | undefined, contextWindow: number | undefined): number | undefined {
  const limit = compactAt ?? contextWindow;
  return limit ? Math.min(1, contextTokens / limit) : undefined;
}

export function formatTokens(tokens: number): string {
  if (tokens >= MILLION) return `${(tokens / MILLION).toFixed(1).replace(/\.0$/, "")}M`;
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(tokens);
}
