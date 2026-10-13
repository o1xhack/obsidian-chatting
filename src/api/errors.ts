/**
 * An error answer from a provider: the HTTP status (0 for an error inside a
 * response that had started), the provider's error code or type, and the
 * wait it asked for with `Retry-After`. `client.ts` decides on a retry from
 * these, never from the message text (which may only name the wait).
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}

/** The `Retry-After` response header in ms: seconds, or an HTTP date. */
export function retryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  const value = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "retry-after")?.[1];
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

/**
 * The wait a message names, in ms: a rate limit inside a ChatGPT (Codex)
 * response has no `Retry-After`, only "Please try again in 11.054s" (or "in 28ms").
 */
export function retryAfterInMessage(message: string): number | undefined {
  const match = /try again in\s*(\d+(?:\.\d+)?)\s*(ms|s)/i.exec(message);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Math.round(match[2].toLowerCase() === "ms" ? value : value * 1000);
}

/**
 * A streamed answer that ended before the provider said it was complete
 * (the connection dropped or timed out, no error from the provider). The
 * agent loop sends the same request again; no tool ran for it yet.
 */
export class StreamCutError extends Error {
  constructor(provider: string) {
    super(`${provider} stream ended before the answer was complete.`);
    this.name = "StreamCutError";
  }
}
