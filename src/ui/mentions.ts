import type { App, TFile } from "obsidian";
import { normalizePath, prepareFuzzySearch } from "obsidian";
import type { FileAttachment, ImageAttachment, MentionContext } from "../types";
import { fileAttachment, isSentAsFile } from "../files/attachments";
import { describeCanvas, isCanvasPath, parseCanvas } from "../tools/canvas";
import { fitImage, imageMediaType } from "../images";

/**
 * Mentions: `@` or `[[` in the chat input offers vault files; the chosen
 * one goes into the text as an Obsidian link (`[[Plan]]`). When the
 * message is sent, the current content of each linked file goes along
 * with it (`mentionContext`), so the AI needn't read it first.
 */

/** Characters of a note sent along, each and all together. */
export const MENTION_CHARS = 20000;
export const MENTION_TOTAL_CHARS = 60000;
/** Files sent along per message at most. */
export const MENTION_FILES = 10;
/** Offered in the list. */
const CANDIDATES = 8;

/** The mention being typed: where its trigger starts, and the text after it. */
export interface MentionQuery {
  start: number;
  query: string;
}

/**
 * The mention the caret is in: `@` at the start or after a space, or `[[`
 * not yet closed, up to the caret on the same line.
 */
export function mentionAt(text: string, caret: number): MentionQuery | null {
  const line = text.slice(text.lastIndexOf("\n", caret - 1) + 1, caret);
  const lineStart = caret - line.length;
  const link = line.lastIndexOf("[[");
  if (link !== -1 && !line.slice(link).includes("]]")) {
    return { start: lineStart + link, query: line.slice(link + 2) };
  }
  const at = line.lastIndexOf("@");
  if (at !== -1 && (at === 0 || /\s/.test(line[at - 1]))) {
    return { start: lineStart + at, query: line.slice(at + 1) };
  }
  return null;
}

/** Files of the vault that match `query` (fuzzy, best first); recent files for an empty one. */
export function mentionCandidates(app: App, query: string, limit = CANDIDATES): TFile[] {
  const files = app.vault.getFiles();
  const trimmed = query.trim();
  if (!trimmed) {
    const recent = app.workspace.getLastOpenFiles()
      .map((path) => app.vault.getFileByPath(path))
      .filter((file): file is TFile => !!file);
    const rest = files.filter((file) => !recent.includes(file)).sort((a, b) => b.stat.mtime - a.stat.mtime);
    return [...recent, ...rest].slice(0, limit);
  }
  const match = prepareFuzzySearch(trimmed);
  return files
    .map((file) => {
      // The name counts more than the folder.
      const byName = match(file.basename)?.score;
      const byPath = match(file.path)?.score;
      const score = byName !== undefined ? byName + 1 : byPath;
      return { file, score };
    })
    .filter((item): item is { file: TFile; score: number } => item.score !== undefined)
    .sort((a, b) => b.score - a.score || a.file.path.length - b.file.path.length)
    .slice(0, limit)
    .map((item) => item.file);
}

/** The text with the mention replaced by a link to `file`, and the caret after it. */
export function insertMention(app: App, text: string, mention: MentionQuery, caret: number, file: TFile, sourcePath: string): { text: string; caret: number } {
  const link = `[[${app.metadataCache.fileToLinktext(file, sourcePath, true)}]]`;
  // A `]]` the input already has after the caret (typed `[[`, closed by the editor) is replaced too.
  const end = text.startsWith("]]", caret) ? caret + 2 : caret;
  const after = text.slice(end);
  const space = after.startsWith(" ") ? "" : " ";
  return { text: `${text.slice(0, mention.start)}${link}${space}${after}`, caret: mention.start + link.length + 1 };
}

/** The files the text links to (`[[…]]`), each once, in order. */
export function mentionedFiles(app: App, text: string, sourcePath: string): TFile[] {
  const files: TFile[] = [];
  for (const [, target] of text.matchAll(/\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g)) {
    const linkpath = normalizePath(target.trim());
    const file = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath) ?? app.vault.getFileByPath(linkpath);
    if (file && !files.includes(file)) files.push(file);
    if (files.length === MENTION_FILES) break;
  }
  return files;
}

/**
 * The mentioned files for the model: a note's or text file's text
 * (capped), a canvas's outline, an image as an image, a PDF or Office
 * file as a file; others only by name.
 */
export async function mentionContext(app: App, mentioned: TFile[]): Promise<MentionContext | null> {
  if (mentioned.length === 0) return null;
  const parts: string[] = [];
  const images: ImageAttachment[] = [];
  const files: FileAttachment[] = [];
  let budget = MENTION_TOTAL_CHARS;
  /** A file's text, within what is left of the budget. */
  const addText = (path: string, content: string) => {
    const room = Math.min(MENTION_CHARS, Math.max(0, budget));
    const cut = content.length > room;
    budget -= Math.min(content.length, room);
    parts.push(`<file path="${path}">\n${content.slice(0, room)}${cut ? `\n(cut after ${room} of ${content.length} characters; use read_document for the rest)` : ""}\n</file>`);
  };
  for (const file of mentioned) {
    const mediaType = imageMediaType(file.path);
    if (mediaType) {
      try {
        const image = await fitImage(await app.vault.readBinary(file), mediaType);
        images.push({ id: `mention-${Date.now()}-${images.length}`, fileName: file.name, mediaType: image.mediaType, data: image.data, sizeBytes: image.sizeBytes });
        parts.push(`<file path="${file.path}">(the image is attached)</file>`);
      } catch {
        parts.push(`<file path="${file.path}">(an image that couldn't be sent; use view_image)</file>`);
      }
    } else if (isCanvasPath(file.path)) {
      let outline: string;
      try {
        outline = describeCanvas(file.path, parseCanvas(await app.vault.cachedRead(file)));
      } catch {
        outline = "(not valid JSON Canvas; use read_file)";
      }
      parts.push(`<file path="${file.path}">\n${outline}\n</file>`);
    } else if (file.extension === "md" || file.extension === "txt") {
      addText(file.path, await app.vault.cachedRead(file));
    } else {
      // PDF and Office files as files, other text as text.
      const attachment = await fileAttachment(file.name, await app.vault.readBinary(file));
      if (typeof attachment === "string") {
        parts.push(`<file path="${file.path}">(not sent along: ${attachment})</file>`);
      } else if (isSentAsFile(attachment)) {
        files.push(attachment);
        parts.push(`<file path="${file.path}">(the file is attached)</file>`);
      } else {
        addText(file.path, attachment.text ?? "");
      }
    }
  }
  return {
    text: `[Files the user linked in this message, as they are now:]\n${parts.join("\n")}`,
    images,
    files,
  };
}
