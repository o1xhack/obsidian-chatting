/**
 * Live voice wire format: the events on the WebRTC data channel (the names
 * Codex's voice service uses: `input_transcript.added`,
 * `delegation.created`, …), and the instructions and seed the voice model
 * starts with.
 */
import type { ChatHistoryEntry } from "../types";
import { isRecord } from "../json";

/** A server event, reduced to what the controller needs. */
export type VoiceEvent =
  | { kind: "input"; text: string }
  | { kind: "output"; text: string }
  | { kind: "turn-done"; role: "user" | "assistant"; text: string }
  /** `text` is empty when the event carries no task text. */
  | { kind: "delegation"; id: string; text: string }
  | { kind: "error"; message: string }
  | { kind: "closed"; reason: string }
  | { kind: "other" };

/** A text message seeding the voice model with the recent chat. */
export interface VoiceItem {
  type: "message";
  role: "user" | "assistant";
  content: { type: "input_text" | "output_text"; text: string }[];
}

/**
 * Our instructions for the voice model. Sections
 * as in OpenAI's GPT-Live prompting guide: what the backend can do, when to
 * delegate and when not, order, speaking. A line saying which file is open
 * follows them (`openFileNote`).
 */
export const VOICE_INSTRUCTIONS = `You are the voice of Chatting with AI, an assistant in the user's Obsidian vault. You only talk. A separate agent, the backend, does all work in the vault; you hand work to it by delegating to the client.

What the backend can do: read, search, create, edit, rename and delete notes; change canvases (add, move, connect or remove cards); set properties and tags; follow links; look at images; read web pages, PDF and Office files; answer questions that need facts or careful reasoning. It sees the note or canvas the user has open.

Delegate when:
- the request needs the vault, the open note or canvas, facts, a lookup or careful reasoning;
- the user adds to, changes or corrects work already requested. Also while it runs: delegate the change at once, don't wait for the running work.
- Every request needs its own delegation, also one said right after or during another task. A task never picks up new requests by itself, and once its result has arrived it is finished.

Don't delegate when:
- you can answer from the conversation or from a result that is still current;
- you need to ask first. If an important detail is unclear (which note, where), ask one short question instead of guessing. "This", "here" or "the card" mean what the user has open.

Order:
- Delegate first. Say that you're on it only after you delegated in this same turn. Never say you'll do something that you haven't handed over.
- Don't guess or invent a result. Say that something is done only when the result says so.

Speaking:
- Notes about steps and progress are for you; don't read them out or repeat "on it". Say what's happening only if the user asks.
- When a result arrives, tell it in short, natural sentences. Don't read out tables, code or long lists; say the details are in the chat.
- Keep replies short. When the user interrupts, stop and listen; stopping your speech doesn't stop the work.`;

/** The file the user has open, for the voice model: `path` and `extension` as in Obsidian's TFile. */
export interface OpenFile {
  path: string;
  extension: string;
}

/** One line telling the voice model what the user has open. */
export function openFileNote(file: OpenFile | null): string {
  if (!file) return "The user has no note or canvas open.";
  const kind = file.extension === "md" ? "note" : file.extension === "canvas" ? "canvas" : "file";
  return `The user has the ${kind} "${file.path}" open.`;
}

/** Answers longer than this are cut and point to the chat. */
export const MAX_SPOKEN_CHARS = 3000;
/** The voice service limits each appended text to 500 bytes. */
const CHUNK_BYTES = 500;
const SEED_ENTRIES = 8;
const SEED_ENTRY_CHARS = 1000;

const str = (value: unknown): string => typeof value === "string" ? value : "";

/** Parse a data-channel message. */
export function parseVoiceEvent(message: unknown): VoiceEvent {
  if (!isRecord(message)) return { kind: "other" };
  switch (message.type) {
    case "input_transcript.added":
      return { kind: "input", text: isRecord(message.item) ? str(message.item.text) : "" };
    case "output_transcript.added":
      return { kind: "output", text: isRecord(message.item) ? str(message.item.text) : "" };
    case "turn.done": {
      const turn = isRecord(message.turn) ? message.turn : {};
      const role = turn.role === "user" || turn.role === "assistant" ? turn.role : undefined;
      return role ? { kind: "turn-done", role, text: str(turn.transcript) } : { kind: "other" };
    }
    case "delegation.created": {
      const item = isRecord(message.item) ? message.item : {};
      const id = str(item.id);
      if (!id || (item.target !== undefined && item.target !== "client")) return { kind: "other" };
      const text = Array.isArray(item.content)
        ? item.content.filter(isRecord).filter((part) => part.type === "input_text").map((part) => str(part.text)).join("")
        : "";
      return { kind: "delegation", id, text };
    }
    case "error": {
      const error = isRecord(message.error) ? message.error : message;
      return { kind: "error", message: str(error.message) || str(error.code) || "The voice session reported an error." };
    }
    case "session.closed":
      return { kind: "closed", reason: str(message.reason) };
    default:
      return { kind: "other" };
  }
}

/** Events that hand a delegation's result to the voice model to say. */
export function speakEvents(delegationId: string, text: string): Record<string, unknown>[] {
  return append(delegationId, "speakable", text);
}

/** Events that tell the voice model about progress, without saying it. */
export function progressEvents(delegationId: string, text: string): Record<string, unknown>[] {
  return append(delegationId, "commentary", text);
}

export const CLOSE_EVENT = { type: "session.close" };

function append(delegationId: string, channel: "speakable" | "commentary", text: string): Record<string, unknown>[] {
  const encoder = new TextEncoder();
  return chunks(text, (part) => encoder.encode(part).length <= CHUNK_BYTES).map((part) => ({
    type: "delegation.context.append",
    delegation_item_id: delegationId,
    channel,
    content: [{ type: "input_text", text: part }],
  }));
}

/** An answer as it is spoken: long ones are cut and point to the chat. */
export function spokenAnswer(text: string): string {
  if (text.length <= MAX_SPOKEN_CHARS) return text;
  const cut = text.slice(0, MAX_SPOKEN_CHARS);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("\n"));
  return `${(end > MAX_SPOKEN_CHARS / 2 ? cut.slice(0, end + 1) : cut).trim()}\n\nThe full answer is in the chat.`;
}

/**
 * Split `text` into parts that `fits`, at whitespace where possible and
 * never inside a character (UTF-8 safe for the byte limit).
 */
export function chunks(text: string, fits: (part: string) => boolean): string[] {
  const parts: string[] = [];
  let current = "";
  // Words with their trailing whitespace (no lookbehind: older iOS lacks it).
  for (const word of text.match(/\s+|\S+\s*/g) ?? []) {
    if (fits(current + word)) {
      current += word;
      continue;
    }
    if (current) parts.push(current);
    current = "";
    for (const char of word) {
      if (current && !fits(current + char)) {
        parts.push(current);
        current = "";
      }
      current += char;
    }
  }
  if (current) parts.push(current);
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** The last few chat messages as text, so the voice model knows the context. */
export function seedItems(history: ChatHistoryEntry[]): VoiceItem[] {
  return history
    .filter((entry) => (entry.type === "user" || entry.type === "assistant") && entry.text?.trim())
    .slice(-SEED_ENTRIES)
    .map((entry) => {
      const role = entry.type === "user" ? "user" : "assistant";
      const text = entry.text!.trim();
      return {
        type: "message",
        role,
        content: [{
          type: role === "user" ? "input_text" : "output_text",
          text: text.length > SEED_ENTRY_CHARS ? `${text.slice(0, SEED_ENTRY_CHARS)}…` : text,
        }],
      };
    });
}
