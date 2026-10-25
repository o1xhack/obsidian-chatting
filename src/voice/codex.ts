/**
 * The voice route: Codex's voice service on the ChatGPT plan, the way the
 * Codex app's voice mode uses it.
 *
 * - Sign-in: the ChatGPT account sign-in the ChatGPT provider uses. It
 *   already signs in as the Codex app (device code flow), so the call
 *   uses its token and account ID; refreshes are shared with the chat.
 * - Call: created through `requestUrl()` on chatgpt.com; audio and events
 *   then go over WebRTC (`session.ts`).
 *
 * Desktop and mobile alike. Like the chat's Codex route, it isn't
 * documented for other apps, so OpenAI may change it at any time.
 */
import { Platform, requestUrl } from "obsidian";
import type { VoiceRoute } from "./session";
import { isRecord } from "../json";

/** Safe service diagnostics; never include the request, SDP or account identity. */
export class VoiceStartError extends Error {
  constructor(readonly status: number, readonly details: { code?: string; requestId?: string; responseType: "json" | "html" | "text" }, message?: string) {
    super(`Couldn't start voice (HTTP ${status}).${details.code ? ` ${details.code}:` : ""}${message ? ` ${message}` : ""}${details.responseType === "html" ? " The voice service returned an HTML page." : ""}${details.requestId ? ` Request ID: ${details.requestId}.` : ""}`);
    this.name = "VoiceStartError";
  }
}

const CALL_URL = "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas";
const CODEX_MODEL = "gpt-live-1-codex";
export const DEFAULT_VOICE = "cove";
/**
 * Codex's voices: `RealtimeVoicesList::builtin().v1` in Codex's source
 * (`codex-rs/protocol/src/protocol.rs`), the list it offers for these calls
 * and checks a choice against; no endpoint lists them, Codex's own list is
 * built in too. Its `v3` list names 16 more, but the service refused each of
 * them with "Voice session access denied." (checked 2026-10-13).
 */
export const VOICES = ["juniper", "maple", "spruce", "ember", "vale", "breeze", "arbor", "sol", "cove"];

/** The ChatGPT sign-in, as the route needs it (`ChatGPTOAuthService`). */
export interface CodexVoiceAuth {
  /** The credential, refreshed when it is about to expire; null when signed out. */
  getUsableCredential(): Promise<{ accessToken: string; accountId?: string; refreshToken?: string } | null>;
  /** Shared one-shot renewal after a server rejection before local expiry. */
  renewRejected(rejected: { accessToken: string; accountId?: string }): Promise<{ accessToken: string; accountId?: string; refreshToken?: string } | null>;
}

/** A route that creates calls on Codex's voice service. */
export function codexVoiceRoute(auth: CodexVoiceAuth, voice: string, clientVersion: () => string): VoiceRoute {
  // Refresh sign-in while preparing the offer. Version metadata is a
  // synchronous cached/fallback read, never a network prerequisite.
  let ready: Promise<[Awaited<ReturnType<CodexVoiceAuth["getUsableCredential"]>>, string]> | null = null;
  const prepared = () => {
    if (!ready) {
      const credential = auth.getUsableCredential();
      const version = clientVersion();
      ready = credential.then(credential => [credential, version]);
    }
    return ready;
  };
  return {
    name: "codex",
    prepare() {
      prepared().catch(() => undefined); // a failure surfaces in connect()
    },
    async connect({ sdp, instructions, items }) {
      const pending = prepared();
      ready = null; // a later call checks again
      const [credential, version] = await pending;
      if (!credential) throw new Error("Connect your ChatGPT account in the settings first.");
      if (!credential.accountId) throw new Error("The ChatGPT sign-in has no account ID. Disconnect and connect it again.");
      // Not crypto.randomUUID(): mobile WebViews may lack it.
      const sessionId = uuidV4();
      const create = (accessToken: string, accountId: string) => requestUrl({
        url: CALL_URL,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
          "ChatGPT-Account-ID": accountId,
          "openai-alpha": "quicksilver=v2",
          "x-session-id": sessionId,
          "session-id": sessionId,
          "thread-id": sessionId,
          originator: "codex_cli_rs",
          "User-Agent": `codex_cli_rs/${version} (${osName()}; unknown) obsidian`,
          version,
        },
        body: JSON.stringify({
          sdp,
          session: {
            instructions,
            audio: { output: { voice: voice || DEFAULT_VOICE } },
            delegation: { type: "client" },
            model: CODEX_MODEL,
            ...(items.length ? { initial_items: items } : {}),
          },
        }),
        throw: false,
      });
      let response = await create(credential.accessToken, credential.accountId);
      const secrets = [credential.accessToken, credential.accountId, credential.refreshToken ?? ""];
      if (response.status === 401) {
        let renewed;
        try { renewed = await auth.renewRejected(credential); } catch { /* Keep the rejected-call status. */ }
        if (renewed?.accountId === credential.accountId) {
          secrets.push(renewed.accessToken, renewed.refreshToken ?? "");
          response = await create(renewed.accessToken, renewed.accountId);
        }
      }
      if (response.status < 200 || response.status >= 300) {
        throw voiceFailure(response.status, response.text, response.headers, secrets);
      }
      const location = Object.entries(response.headers ?? {}).find(([name]) => name.toLowerCase() === "location")?.[1] ?? "";
      const callId = location.split("?")[0].split("/").filter(Boolean).pop();
      return { sdp: response.text, callId };
    },
  };
}

/** Extract only bounded diagnostic fields; HTML/proxy pages are never copied. */
function voiceFailure(status: number, body: string, headers: Record<string, string> | undefined, secrets: string[]): VoiceStartError {
  const redact = (value: string): string => {
    for (const secret of secrets) if (secret) value = value.split(secret).join("[redacted]");
    return value.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/\b(?:sk-[\w-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, "[redacted]")
      .replace(/[\w.+-]+@[\w.-]+\.[a-zA-Z]{2,}/g, "[redacted]")
      .replace(/[\r\n\t]+/g, " ").slice(0, 350);
  };
  let data: unknown;
  let json = false;
  try { data = JSON.parse((body ?? "").slice(0, 16_384)); json = true; } catch { /* Only known plain-text errors are copied below. */ }
  const packet = isRecord(data) ? data : {};
  const error = isRecord(packet.error) ? packet.error : {};
  const string = (...values: unknown[]): string | undefined => values.find((value): value is string => typeof value === "string" && !!value.trim());
  const rawCode = string(error.code, error.type, packet.code);
  const code = rawCode && /^[a-zA-Z][\w.-]{0,79}$/.test(rawCode) ? redact(rawCode) : undefined;
  const contentType = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "";
  const html = !json && (/^\s*</.test(body ?? "") || /text\/html/i.test(contentType));
  const plain = (body ?? "").trim();
  const knownText = !json && !html && /^(?:voice session access denied|not found|unauthorized|forbidden|model not found|too many requests)\.?$/i.test(plain) ? plain : undefined;
  const rawMessage = string(error.message, packet.error, packet.message, packet.detail, knownText);
  const message = rawMessage && /\bv=0[\r\n]|(?:^|[\r\n])(?:a=|m=audio|c=IN)/.test(rawMessage)
    ? "The voice service rejected the connection description."
    : rawMessage ? redact(rawMessage) : undefined;
  const requestId = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === "x-request-id")?.[1];
  return new VoiceStartError(status, {
    ...(code ? { code } : {}),
    ...(requestId && /^[\w-]{1,128}$/.test(requestId) ? { requestId: redact(requestId) } : {}),
    responseType: json ? "json" : html ? "html" : "text",
  }, message);
}

/** Codex sends its OS here (the CPU, which follows, isn't known without Node modules). */
function osName(): string {
  return Platform.isMacOS ? "Mac OS" : Platform.isWin ? "Windows" : Platform.isLinux ? "Linux" : "Unknown";
}

/** A random version 4 UUID from `crypto.getRandomValues()`. */
function uuidV4(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
