import { App, normalizePath } from "obsidian";
import type { UnifiedMessage } from "../types";

/**
 * The vault's own instructions for the AI, in `AGENTS.md` files (the
 * agents.md convention): the one at the vault root goes into the system
 * prompt; one in a folder goes along with the first tool result of the
 * conversation that touches a file in that folder.
 */

export const INSTRUCTIONS_FILE = "AGENTS.md";
/** Characters read from each file (as Codex caps its project docs). */
export const INSTRUCTIONS_CHARS = 32768;

async function readInstructions(app: App, path: string): Promise<string | null> {
  const file = app.vault.getFileByPath(normalizePath(path));
  if (!file) return null;
  const text = (await app.vault.cachedRead(file)).trim();
  if (!text) return null;
  return text.length > INSTRUCTIONS_CHARS ? `${text.slice(0, INSTRUCTIONS_CHARS)}\n(cut after ${INSTRUCTIONS_CHARS} characters)` : text;
}

/** The vault root's AGENTS.md, if there is one. */
export function rootInstructions(app: App): Promise<string | null> {
  return readInstructions(app, INSTRUCTIONS_FILE);
}

/** The folders of `path` from the top down, without the vault root ("A/B/c.md": "A", "A/B"). */
function foldersOf(path: string): string[] {
  const parts = normalizePath(path).split("/").slice(0, -1);
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** How a folder's instructions start in a tool result; `instructionsGiven` finds them by it. */
const header = (folder: string, path: string) =>
  `[Instructions for files in ${folder}/, from ${path}; they add to the vault's instructions and win where they differ:]`;
const HEADER = /\[Instructions for files in .*?\/, from (.+?); they add to the vault's instructions/g;

/** The folder AGENTS.md files the history has already given to the model. */
export function instructionsGiven(messages: UnifiedMessage[]): Set<string> {
  const given = new Set<string>();
  for (const message of messages) {
    if (typeof message.content === "string") continue;
    for (const block of message.content) {
      if (block.type !== "tool_result" || !block.content?.includes("[Instructions for files in ")) continue;
      for (const [, path] of block.content.matchAll(HEADER)) given.add(path);
    }
  }
  return given;
}

/**
 * Folder AGENTS.md files for files the tools touch, not yet `given`, outer
 * folders first, as text for a tool result; empty when there are none.
 * Found again by the history, so they come once per conversation, and
 * again after the turn that had them was cut away.
 */
export async function folderInstructions(app: App, paths: string[], given: Set<string>): Promise<string> {
  const parts: string[] = [];
  for (const folder of [...new Set(paths.flatMap(foldersOf))]) {
    const path = `${folder}/${INSTRUCTIONS_FILE}`;
    if (given.has(path)) continue;
    const text = await readInstructions(app, path);
    if (text) parts.push(`${header(folder, path)}\n${text}`);
  }
  return parts.join("\n\n");
}

/** Tools whose `path` defaults to the active note. */
const ACTIVE_NOTE_TOOLS = ["read_document", "edit_document", "get_properties", "set_properties", "get_links"];

/** The files a tool call concerns (`path`, `new_path`, else the active note), for folder instructions. */
export function toolPaths(app: App, name: string, input: Record<string, unknown>): string[] {
  const paths = [input.path, input.new_path].filter((value): value is string => typeof value === "string" && value.trim() !== "");
  const active = app.workspace.getActiveFile()?.path;
  if (paths.length === 0 && active && ACTIVE_NOTE_TOOLS.includes(name)) paths.push(active);
  return paths;
}
