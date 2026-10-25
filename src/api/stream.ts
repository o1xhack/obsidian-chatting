/**
 * Transport for streamed chat requests: the one place that uses `fetch`
 * (`browserFetch`) and Node's `https` (desktop only). Everything else uses
 * `requestUrl()` (the desktop ChatGPT sign-in's callback server uses Node's
 * `http`, `auth/chatgptBrowserLogin.ts`).
 *
 * The request is a POST whose answer is Server-Sent Events. Each event's
 * JSON is handed to `onEvent` as it arrives:
 * - Desktop: Node's `https` (Electron), which no CORS check applies to,
 *   loaded at runtime.
 * - Mobile: `fetch`. Anthropic and OpenAI (API key) allow it.
 * If either fails before any response (CORS block, network error, a proxy
 * or certificate Node doesn't handle), the same request goes through
 * `requestUrl()`, which buffers the whole stream; its events are then
 * delivered at once. A connection lost after the answer began is a
 * `StreamDropped` (the adapters make it a `StreamCutError`). When `fetch` failed like a CORS block
 * and that fallback reached the server, later requests to the URL skip
 * `fetch` for 10 minutes. A `fetch` that failed while Obsidian was in the
 * background just fails: the agent loop sends it again once the app is
 * back.
 *
 * Each request records when its last data arrived (`lastChunkAt()`), so
 * the agent loop can tell a request that stalled in the background.
 */
import { Platform, requestUrl } from "obsidian";
import { isRecord, readJson } from "../json";
import { retryAfterMs } from "./errors";
import { appLifecycle } from "../platform/lifecycle";

export interface StreamRequest {
  headers: Record<string, string>;
  body: string;
  /** For remote tools, fallback requires proof that no HTTP request was submitted. */
  noFallback?: boolean;
}

/**
 * The HTTP status; for errors (not 2xx) also the body, as text and JSON,
 * and the wait the `Retry-After` header asks for.
 */
export interface StreamResult {
  status: number;
  text?: string;
  json?: unknown;
  retryAfterMs?: number;
}

export type SSEHandler = (event: Record<string, unknown>) => void;

/** The connection was lost after the answer began (no clean end). */
export class StreamDropped extends Error {
  constructor(cause: unknown) {
    super(`The connection was lost while the answer streamed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "StreamDropped";
  }
}

/** Node's request failed before any response: `requestUrl()` may still reach the server. */
class NoResponse extends Error {
  constructor(readonly cause: Error) {
    super(cause.message);
    this.name = "NoResponse";
  }
}

/** Local transport evidence that no HTTP request could have left this client. */
export class RequestNotSent extends Error {
  constructor(readonly cause: Error) {
    super(cause.message);
    this.name = "RequestNotSent";
  }
}

/** How long `fetch` is skipped for a URL after it looked blocked. */
const FETCH_BLOCK_MS = 10 * 60_000;

/**
 * URLs where `fetch` failed like a CORS block (a `TypeError` before any
 * response) while `requestUrl()` reached the server, with the time until
 * which `fetch` is skipped there. A brief network failure looks the same,
 * so the block ends after `FETCH_BLOCK_MS` (and on reload).
 */
const fetchBlockedUntil = new Map<string, number>();

/** When data last arrived for the request with this signal. */
const lastChunk = new WeakMap<AbortSignal, number>();

/** When data last arrived for the request with `signal`; undefined before any. */
export function lastChunkAt(signal: AbortSignal): number | undefined {
  return lastChunk.get(signal);
}

function received(signal?: AbortSignal): void {
  if (signal) lastChunk.set(signal, Date.now());
}

/** Requests sent through `requestUrl()`, which buffers the whole answer. */
const buffered = new WeakSet<AbortSignal>();

/** The request with `signal` goes through `requestUrl()`: no data arrives before its end. */
export function isBuffered(signal: AbortSignal): boolean {
  return buffered.has(signal);
}

/**
 * The plugin's only `fetch`. Called as `window.fetch`: Obsidian's review
 * lint flags the bare global and forbids switching that rule off in a
 * comment.
 */
export function browserFetch(url: string, init: RequestInit): Promise<Response> {
  return window.fetch(url, init);
}

/** For tests: forget that `fetch` was blocked. */
export function resetStreamTransport(): void {
  fetchBlockedUntil.clear();
}

export async function streamSSE(
  url: string,
  request: StreamRequest,
  onEvent: SSEHandler,
  signal?: AbortSignal,
): Promise<StreamResult> {
  throwIfAborted(signal);
  const https = nodeHttps();
  if (https) {
    const startedAt = Date.now();
    try {
      return await viaNode(https, url, request, onEvent, signal);
    } catch (error) {
      // No answer at all (a system proxy, a certificate only the OS trusts):
      // Obsidian's requestUrl() reaches the server as before streaming.
      const notSent = error instanceof RequestNotSent;
      if (signal?.aborted || (!(error instanceof NoResponse) && !notSent) || (request.noFallback && !notSent)) throw error;
      if (notSent && appLifecycle.hiddenSince(startedAt)) throw error;
      return viaRequestUrl(url, request, onEvent, signal);
    }
  }
  if ((fetchBlockedUntil.get(url) ?? 0) <= Date.now()) {
    let response: Response | undefined;
    let failure: unknown;
    const startedAt = Date.now();
    try {
      response = await browserFetch(url, { method: "POST", headers: request.headers, body: request.body, signal });
    } catch (error) {
      throwIfAborted(signal);
      if (request.noFallback) throw error;
      // In the background the network is cut, not blocked: no fallback
      // now, no block for later; the loop sends it again when the app is back.
      if (appLifecycle.hiddenSince(startedAt)) throw error;
      // No response at all: try requestUrl() below.
      failure = error;
    }
    if (response) return readFetchResponse(response, onEvent, signal);
    const result = await viaRequestUrl(url, request, onEvent, signal);
    if (failure instanceof TypeError) fetchBlockedUntil.set(url, Date.now() + FETCH_BLOCK_MS);
    return result;
  }
  return viaRequestUrl(url, request, onEvent, signal);
}

// ─── Desktop: Node https ────────────────────────────────────────────────────

interface NodeResponse {
  statusCode?: number;
  headers?: Record<string, string | string[] | undefined>;
  setEncoding(encoding: string): void;
  on(event: "data", listener: (chunk: string) => void): void;
  on(event: "end", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
}

interface NodeRequest {
  on(event: "error", listener: (error: Error) => void): void;
  on(event: "socket", listener: (socket: NodeSocket) => void): void;
  reusedSocket?: boolean;
  write(body: string): void;
  end(): void;
  destroy(): void;
}

interface NodeSocket {
  connecting?: boolean;
  encrypted?: boolean;
  on(event: "secureConnect", listener: () => void): void;
}

interface NodeHttps {
  request(url: string, options: { method: string; headers: Record<string, string> },
    callback: (response: NodeResponse) => void): NodeRequest;
}

/**
 * Node's `https` module on desktop (Electron), loaded at runtime so the
 * bundle doesn't need it; undefined on mobile.
 */
function nodeHttps(): NodeHttps | undefined {
  if (!Platform.isDesktopApp || typeof window === "undefined") return undefined;
  const load = (window as unknown as { require?: (id: string) => unknown }).require;
  try {
    return load?.("https") as NodeHttps | undefined;
  } catch {
    return undefined;
  }
}

function viaNode(https: NodeHttps, url: string, request: StreamRequest, onEvent: SSEHandler,
  signal?: AbortSignal): Promise<StreamResult> {
  return new Promise((resolve, reject) => {
    const headers = { ...request.headers, "Content-Length": String(new TextEncoder().encode(request.body).length) };
    let responded = false;
    // For MCP, don't queue HTTP headers/body until TLS is ready. This makes
    // an early failure provably unsent, without guessing from byte counters.
    let submitted = false;
    let settled = false;
    const req = https.request(url, { method: "POST", headers }, (res) => {
      responded = true;
      const status = res.statusCode ?? 0;
      res.setEncoding("utf8");
      const ok = status >= 200 && status < 300;
      const parser = ok ? createSSEParser(onEvent) : undefined;
      let errorText = "";
      res.on("data", (chunk) => {
        if (signal?.aborted) return;
        received(signal);
        if (parser) parser.push(chunk);
        else errorText += chunk;
      });
      res.on("error", (error) => fail(parser ? new StreamDropped(error) : error));
      res.on("end", () => {
        settled = true;
        signal?.removeEventListener("abort", abort);
        if (signal?.aborted) return reject(new Error("Request cancelled."));
        if (parser) {
          parser.end();
          resolve({ status });
        } else {
          const retryAfter = res.headers?.["retry-after"];
          resolve({ status, text: errorText, json: parseJson(errorText),
            retryAfterMs: retryAfterMs({ "retry-after": (Array.isArray(retryAfter) ? retryAfter[0] : retryAfter) ?? "" }) });
        }
      });
    });
    function fail(error: Error) {
      settled = true;
      signal?.removeEventListener("abort", abort);
      reject(signal?.aborted && !(error instanceof RequestNotSent) ? new Error("Request cancelled.") : error);
    }
    function abort() {
      req.destroy();
      const error = new Error("Request cancelled.");
      fail(request.noFallback && !submitted && !responded ? new RequestNotSent(error) : error);
    }
    signal?.addEventListener("abort", abort);
    req.on("socket", socket => {
      if (!request.noFallback) return;
      if (!req.reusedSocket && socket.connecting === true && socket.encrypted === true) {
        socket.on("secureConnect", submit);
      } else {
        // Reused TLS connections have no new secureConnect. Unknown socket
        // shapes submit conservatively and lose the safe-to-retry guarantee.
        submit();
      }
    });
    req.on("error", (error) => fail(responded ? error : request.noFallback && !submitted
      ? new RequestNotSent(error) : new NoResponse(error)));
    function submit() {
      if (settled || submitted || signal?.aborted) return;
      submitted = true;
      req.write(request.body);
      req.end();
    }
    if (!request.noFallback) submit();
  });
}

// ─── Mobile: fetch ──────────────────────────────────────────────────────────

async function readFetchResponse(response: Response, onEvent: SSEHandler, signal?: AbortSignal): Promise<StreamResult> {
  if (!response.ok) {
    const text = await response.text();
    return { status: response.status, text, json: parseJson(text),
      retryAfterMs: retryAfterMs({ "retry-after": response.headers.get("retry-after") ?? "" }) };
  }
  const parser = createSSEParser(onEvent);
  const reader = response.body?.getReader();
  if (!reader) {
    // No readable body: take it whole.
    const text = await response.text();
    throwIfAborted(signal);
    received(signal);
    parser.push(text);
    parser.end();
    return { status: response.status };
  }
  const cancel = () => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel);
  try {
    const decoder = new TextDecoder();
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (error) {
        throwIfAborted(signal);
        throw new StreamDropped(error);
      }
      const { done, value } = chunk;
      throwIfAborted(signal);
      if (done) break;
      received(signal);
      parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
  return { status: response.status };
}

// ─── Fallback: requestUrl() ─────────────────────────────────────────────────

/**
 * `requestUrl()` can't be cancelled: an abort settles this at once (the
 * native request goes on, its result is dropped), so a request hung in the
 * background can be given up.
 */
async function viaRequestUrl(url: string, request: StreamRequest, onEvent: SSEHandler, signal?: AbortSignal): Promise<StreamResult> {
  if (signal) buffered.add(signal);
  const sent = requestUrl({ url, method: "POST", headers: request.headers, body: request.body, throw: false });
  const response = await untilAborted(sent, signal);
  throwIfAborted(signal);
  received(signal);
  let text: string | undefined;
  try {
    text = response.text;
  } catch {
    text = undefined;
  }
  if (response.status < 200 || response.status >= 300) {
    return { status: response.status, text, json: readJson(response), retryAfterMs: retryAfterMs(response.headers) };
  }
  const parser = createSSEParser(onEvent);
  parser.push(text ?? "");
  parser.end();
  return { status: response.status };
}

/**
 * Incremental Server-Sent Events parser. Text may arrive split anywhere;
 * lines end in LF, CRLF or CR. `data:` lines of one event are joined with
 * newlines and parsed as JSON; comments, `[DONE]` and malformed JSON are
 * skipped. An event without `type` takes it from its `event:` field.
 */
export function createSSEParser(onEvent: SSEHandler): { push(text: string): void; end(): void } {
  let buffer = "";
  // Where the next line break search starts: the text before it has none,
  // so a long line arriving in many chunks is scanned once.
  let scanFrom = 0;
  let data: string[] = [];
  let eventName = "";

  const dispatch = () => {
    const payload = data.join("\n");
    const name = eventName;
    data = [];
    eventName = "";
    if (!payload || payload === "[DONE]") return;
    const event = parseJson(payload);
    if (!isRecord(event)) return;
    if (typeof event.type !== "string" && name) event.type = name;
    onEvent(event);
  };

  const line = (text: string) => {
    if (text === "") {
      dispatch();
      return;
    }
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") data.push(value);
    else if (field === "event") eventName = value;
  };

  return {
    push(text: string) {
      buffer += text;
      let start = 0;
      let i = scanFrom;
      for (; i < buffer.length; i++) {
        const c = buffer[i];
        if (c !== "\n" && c !== "\r") continue;
        // A CR at the end may be the first half of CRLF: wait for more.
        if (c === "\r" && i === buffer.length - 1) break;
        line(buffer.slice(start, i));
        if (c === "\r" && buffer[i + 1] === "\n") i++;
        start = i + 1;
      }
      buffer = buffer.slice(start);
      scanFrom = Math.max(0, i - start);
    },
    end() {
      if (buffer) line(buffer.replace(/\r$/, ""));
      buffer = "";
      scanFrom = 0;
      dispatch();
    },
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** `promise`, or a "Request cancelled." error as soon as `signal` aborts. */
function untilAborted<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Request cancelled."));
    if (signal.aborted) abort();
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Request cancelled.");
}
