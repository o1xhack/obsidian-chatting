import type { ChatSettings, UnifiedMessage, UnifiedToolDef, UnifiedResponse, StreamOptions } from "../types";
import { sendAnthropicMessage } from "./anthropic";
import { sendOpenAIMessage } from "./openai";
import { sendChatGPTOAuthMessage } from "./chatgpt-oauth";
import { ProviderError, retryAfterInMessage } from "./errors";
import { activeServers } from "./mcp";

/** HTTP statuses of a rate limit or an overload. */
const RETRY_STATUSES = [429, 529];
/**
 * Error codes of a rate limit or an overload (Anthropic's types, OpenAI's and
 * the Codex backend's codes). They decide where the status doesn't: an error
 * inside an OpenAI or ChatGPT response that had started (status 0), and the
 * Codex backend's overload (a 503 with server_is_overloaded or slow_down).
 */
const RETRY_CODES = ["rate_limit_error", "overloaded_error", "rate_limit_exceeded", "server_is_overloaded", "slow_down"];
/**
 * Limits a short wait doesn't lift, though some come as a 429: OpenAI's
 * exhausted quota, and the ChatGPT plan's usage limit (Codex backend).
 */
const USAGE_LIMIT_CODES = ["insufficient_quota", "usage_limit_reached", "usage_not_included"];
/** Wait before the retry when the provider names none; a longer wait than the cap is not retried. */
const RETRY_DELAY_MS = 5000;
const MAX_RETRY_DELAY_MS = 30_000;

/**
 * Dispatches a message to the appropriate provider adapter.
 * Retries once on a rate limit or overload, decided by the HTTP status or
 * error code (not by the message text), after the wait the provider asks
 * for (`Retry-After`, else "try again in 11.054s" in the message). A usage
 * limit is not retried, nor a wait longer than 30 s, nor a request whose
 * answer text is already on screen (a retry would show it twice).
 */
export async function sendMessage(
  settings: ChatSettings,
  messages: UnifiedMessage[],
  tools: UnifiedToolDef[],
  systemPrompt: string,
  shouldStop: () => boolean = () => false,
  stream: StreamOptions = {},
): Promise<UnifiedResponse> {
  let shown = false;
  const options: StreamOptions = {
    signal: stream.signal,
    onTextDelta: (text) => {
      shown = true;
      stream.onTextDelta?.(text);
    },
    // A provider-run tool (an MCP call) may have changed something: no retry either.
    onServerTool: () => {
      shown = true;
      stream.onServerTool?.();
    },
  };
  const doSend = async () => {
    if (shouldStop()) throw new Error("Request cancelled.");
    // Freeze exactly the server configuration whose uncertainty is saved.
    // A backoff retry takes a fresh snapshot, including newly enabled servers.
    const attempt = { ...settings, mcpServers: settings.mcpServers?.map(server => ({ ...server })) };
    await stream.onRequestStarted?.(attempt.provider !== "chatgpt-oauth" && activeServers(attempt).length > 0);
    if (shouldStop()) throw new Error("Request cancelled.");
    if (attempt.provider === "anthropic") {
      return sendAnthropicMessage(attempt, messages, tools, systemPrompt, options);
    }
    if (attempt.provider === "chatgpt-oauth") {
      return sendChatGPTOAuthMessage(attempt, messages, tools, systemPrompt, shouldStop, options);
    }
    return sendOpenAIMessage(attempt, messages, tools, systemPrompt, options);
  };

  try {
    return await doSend();
  } catch (e) {
    if (!isRateLimit(e) || shown) throw e;
    const wait = e.retryAfterMs ?? retryAfterInMessage(e.message) ?? RETRY_DELAY_MS;
    // The user sees the error rather than a long silent wait.
    if (wait > MAX_RETRY_DELAY_MS) throw e;
    await sleep(wait);
    return await doSend();
  }
}

function isRateLimit(e: unknown): e is ProviderError {
  if (!(e instanceof ProviderError)) return false;
  if (e.remoteEffectsPossible) return false;
  if (e.code !== undefined && USAGE_LIMIT_CODES.includes(e.code)) return false;
  return RETRY_STATUSES.includes(e.status) || (e.code !== undefined && RETRY_CODES.includes(e.code));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
