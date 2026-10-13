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
  getUsableCredential(): Promise<{ accessToken: string; accountId?: string } | null>;
}

/** A route that creates calls on Codex's voice service. */
export function codexVoiceRoute(auth: CodexVoiceAuth, voice: string, clientVersion: () => Promise<string>): VoiceRoute {
  // The sign-in (refreshed if it expires soon) and the Codex version don't
  // depend on the offer: fetched while the microphone and offer are prepared.
  let ready: Promise<[{ accessToken: string; accountId?: string } | null, string]> | null = null;
  const prepared = () => ready ??= Promise.all([auth.getUsableCredential(), clientVersion()]);
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
      const response = await requestUrl({
        url: CALL_URL,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${credential.accessToken}`,
          "ChatGPT-Account-ID": credential.accountId,
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
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`Couldn't start voice (HTTP ${response.status}).`);
      }
      const location = Object.entries(response.headers ?? {}).find(([name]) => name.toLowerCase() === "location")?.[1] ?? "";
      const callId = location.split("?")[0].split("/").filter(Boolean).pop();
      return { sdp: response.text, callId };
    },
  };
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
