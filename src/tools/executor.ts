import { App, TFile, getFrontMatterInfo, normalizePath } from "obsidian";
import type { SelectionScope, ToolResult, ViewTarget } from "../types";
import { changedRange, showInView } from "../ui/show-in-view";
import { listMetadata, queryNotes } from "./metadata-query";
import { getLinks } from "./links";
import { applyCanvasOperations, canvasSearchTexts, describeCanvas, isCanvasPath, parseCanvas, serializeCanvas } from "./canvas";
import { renderCanvas, shortIds } from "./canvas-render";
import { selectionHash } from "../selection-history";
import { canvasImageWithinBudget, PREVIEW_SOURCE_BYTES } from "./image-preview";
import { readWebPage } from "./web-page";
import type { ChangeLog } from "./undo";
import { fileAttachment, isDocumentFile, MAX_FILE_BYTES } from "../files/attachments";
import { DEFAULT_SKILLS_FOLDER, useSkill } from "../agent/skills";
import { MAX_SOURCE_IMAGE_BYTES, createCanvasElement, decodeImage, encodeCanvas, extensionOf, fitImage, formatBytes, imageMediaType, isImagePath } from "../images";

/**
 * Files the read tools refuse because their text would be useless to the
 * model. Best effort by extension: an unlisted binary file is still read.
 */
const BINARY_EXTENSIONS = [
  "pdf", "epub", "zip", "gz", "tar", "7z", "rar", "jar", "iso", "dmg", "exe", "dll", "so", "dylib", "bin",
  "mp3", "wav", "m4a", "ogg", "flac", "aac", "opus",
  "webm", "mp4", "m4v", "mov", "mkv", "avi", "ogv", "3gp", "mpeg", "mpg",
  "woff", "woff2", "ttf", "otf", "eot", "psd", "raw",
  "doc", "docx", "xls", "xlsx", "ppt", "pptx", "odt", "sqlite", "db",
];

type AskUserCallback = (question: string) => Promise<string>;

/**
 * Executes a tool call against the Obsidian Vault API.
 * Uses docs-recommended patterns:
 * - getFileByPath() for direct file lookups
 * - cachedRead() for display-only reads
 * - vault.process() for atomic edits
 * - fileManager.renameFile() for link-aware renames
 * - fileManager.trashFile() for safe deletes
 * Changes to the vault are recorded in `changes` (undo per answer).
 */
export async function executeTool(
  app: App,
  toolName: string,
  input: Record<string, unknown>,
  onAskUser: AskUserCallback,
  scope?: SelectionScope,
  changes?: ChangeLog,
  skillsFolder = DEFAULT_SKILLS_FOLDER
): Promise<ToolResult> {
  if (Object.prototype.hasOwnProperty.call(input, "_raw")) {
    return { result: "Invalid tool arguments: provide a valid JSON object and retry.", isError: true };
  }
  try {
    const outOfScope = scope && scopeGuard(app, toolName, input, scope);
    if (outOfScope) return outOfScope;
    switch (toolName) {
      case "read_document":
        return await readDocument(app, input);
      case "edit_document":
        return await editDocument(app, input, scope, changes);
      case "search_vault":
        return await searchVault(app, input);
      case "read_file":
        return await readFile(app, input);
      case "view_image":
        return await viewImage(app, input);
      case "read_canvas":
        return await readCanvas(app, input);
      case "view_canvas":
        return await viewCanvas(app, input);
      case "edit_canvas":
        return await editCanvas(app, input, changes);
      case "create_file":
        return await createFile(app, input, changes);
      case "list_files":
        return await listFiles(app, input);
      case "rename_file":
        return await renameFile(app, input, changes);
      case "delete_file":
        return await deleteFile(app, input, changes);
      case "get_properties":
        return await getProperties(app, input);
      case "set_properties":
        return await setProperties(app, input, changes);
      case "query_notes":
        return queryNotes(app, input);
      case "list_metadata":
        return listMetadata(app, input);
      case "get_links":
      case "get_backlinks": // its earlier name, in saved chats
        return await getNoteLinks(app, input);
      case "get_current_datetime":
        return getCurrentDatetime();
      case "use_skill":
        return await useSkill(app, skillsFolder, input);
      case "open_document":
        return await openDocument(app, input);
      case "ask_user":
        return await askUser(input, onAskUser);
      case "read_web_page":
        return await readWebPage(input);
      default:
        return { result: `Unknown tool: ${toolName}`, isError: true };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { result: `Tool error: ${msg}`, isError: true };
  }
}

// ─── Selection scope ────────────────────────────────────────────────────────
// A turn sent with a selection may change only the selected text of that
// note (the instruction in the user message alone isn't always followed).
// edit_document's find_replace works inside the selection; the other ways
// to change that note are refused. Other notes stay editable.

const scopeRefusal = (path: string): ToolResult => ({
  result: `Not changed: the user selected text in ${path}, and only that selection may change. Use edit_document with operation find_replace and text from within the selection.`,
  isError: true,
});

/** Refuses tools other than edit_document that would change the scoped note. */
function scopeGuard(
  app: App,
  toolName: string,
  input: Record<string, unknown>,
  scope: SelectionScope
): ToolResult | null {
  if (toolName === "rename_file" || toolName === "delete_file") {
    // The note itself, or a folder it is in (the vault root included).
    const given = optionalString(input.path);
    const path = given === undefined ? undefined : normalizePath(given).replace(/\/+$/, "");
    const touches = path !== undefined && (path === scope.filePath || path === "" || scope.filePath.startsWith(`${path}/`));
    return touches ? scopeRefusal(scope.filePath) : null;
  }
  if (toolName === "set_properties" && resolveFile(app, optionalString(input.path))?.path === scope.filePath) {
    return scopeRefusal(scope.filePath);
  }
  // A selection in a canvas card scopes the canvas file.
  if (toolName === "edit_canvas" && normalizePath(requiredString(input.path)) === scope.filePath) {
    return scopeRefusal(scope.filePath);
  }
  return null;
}

/** How many copies of `text` start before `end` in `data` (not overlapping). */
export function copiesBefore(data: string, text: string, end: number): number {
  if (!text) return 0;
  let count = 0;
  for (let at = data.indexOf(text); at !== -1 && at < end; at = data.indexOf(text, at + text.length)) count++;
  return count;
}

/** Relocate through one contiguous edit outside the original range; otherwise fail closed. */
function selectionStart(data: string, text: string, from?: number, sourceText?: string): number {
  if (!text) return -1;
  if (sourceText !== undefined && from !== undefined) {
    if (!sourceText.startsWith(text, from)) return -1;
    if (sourceText === data) return from;
    // Losing a duplicate makes its identity ambiguous, even when an identical
    // neighbour now occupies the old offset. Ask for a new selection.
    if (copiesBefore(data, text, data.length) < copiesBefore(sourceText, text, sourceText.length)) return -1;
    let prefix = 0;
    while (prefix < sourceText.length && prefix < data.length && sourceText[prefix] === data[prefix]) prefix++;
    let suffix = 0;
    while (suffix < sourceText.length && suffix < data.length &&
      sourceText[sourceText.length - 1 - suffix] === data[data.length - 1 - suffix]) suffix++;
    const oldEnd = sourceText.length - suffix;
    const newEnd = data.length - suffix;
    const start = oldEnd <= from ? from + newEnd - oldEnd : prefix >= from + text.length ? from : -1;
    return start >= 0 && data.startsWith(text, start) ? start : -1;
  }
  // Older callers without a snapshot may use an exact offset or a unique
  // match, but must never guess between repeated copies after a change.
  if (from !== undefined) return data.startsWith(text, from) ? from : -1;
  const at = data.indexOf(text);
  return at !== -1 && data.indexOf(text, at + 1) === -1 ? at : -1;
}

/** The position in `data` of an editor offset (the editor counts \r\n as one character). */
function crlfOffset(data: string, offset: number): number {
  let at = 0;
  for (let i = 0; i < offset && at < data.length; i++) at += data.startsWith("\r\n", at) ? 2 : 1;
  return at;
}

/**
 * find_replace inside the selection: `find` is looked up in the selected
 * text (not the first match in the note), and the scope then holds the
 * changed text, so later edits in the turn stay inside it too.
 */
async function editInScope(
  app: App,
  file: TFile,
  scope: SelectionScope,
  find: string,
  content: string
): Promise<ToolResult> {
  // Set in the callback; the cast keeps TypeScript from narrowing it to "done".
  let outcome = "done" as "done" | "outside" | "lost";
  let multiple = false;
  let nextScope: SelectionScope | undefined;
  await app.vault.process(file, (data) => {
    // The editor's selection and offset use \n line breaks; a note saved
    // with \r\n is matched and written with \r\n.
    const crlf = data.includes("\r\n");
    const inNote = (text: string) => (crlf ? text.replace(/\r?\n/g, "\r\n") : text);
    const selected = inNote(scope.text);
    const sourceText = scope.sourceText === undefined ? undefined : inNote(scope.sourceText);
    const from = crlf && scope.from !== undefined ? crlfOffset(sourceText ?? data, scope.from) : scope.from;
    const sourceMatches = sourceText !== undefined || scope.sourceHash === undefined || selectionHash(data) === scope.sourceHash;
    const start = sourceMatches ? selectionStart(data, selected, from, sourceText) : -1;
    const at = scope.text.indexOf(find);
    if (start === -1 || at === -1) {
      outcome = start === -1 ? "lost" : "outside";
      return data;
    }
    multiple = scope.text.indexOf(find, at + 1) !== -1;
    const nextText = scope.text.slice(0, at) + content + scope.text.slice(at + find.length);
    const changed = data.slice(0, start) + inNote(nextText) + data.slice(start + selected.length);
    nextScope = { ...scope, text: nextText,
      from: crlf ? data.slice(0, start).replace(/\r\n/g, "\n").length : start,
      occurrence: copiesBefore(changed, inNote(nextText), start),
      sourceText: changed.replace(/\r\n/g, "\n"),
    };
    return changed;
  });
  if (outcome === "lost") {
    return {
      result: `Not changed: the selected text is no longer in ${file.path} as it was selected. Tell the user; they can select it again and resend.`,
      isError: true,
    };
  }
  if (outcome === "outside") {
    return {
      result: `Not changed: 'find' must be text from within the user's selection in ${file.path}; nothing outside it may change.`,
      isError: true,
    };
  }
  if (nextScope) Object.assign(scope, nextScope);
  const note = multiple ? "[Note: Multiple matches found in the selection, replacing first occurrence.]\n" : "";
  return { result: `${note}Successfully replaced text in the selection in ${file.path}.`, isError: false };
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Resolve a file from path or active file */
function resolveFile(app: App, path?: string): TFile | null {
  if (path) {
    return app.vault.getFileByPath(normalizePath(path));
  }
  return app.workspace.getActiveFile();
}

/** Ensure parent folders exist for a path */
async function ensureParentFolder(app: App, filePath: string, changes?: ChangeLog): Promise<void> {
  const parentPath = filePath.substring(0, filePath.lastIndexOf("/"));
  if (parentPath && !app.vault.getFolderByPath(parentPath)) {
    // The folders that didn't exist yet, outermost first (undo removes them again).
    const parts = parentPath.split("/");
    const missing = parts.map((_, i) => parts.slice(0, i + 1).join("/")).filter((folder) => !app.vault.getFolderByPath(folder));
    await app.vault.createFolder(parentPath);
    changes?.foldersCreated(missing);
  }
}

/** An error for an image or binary file, whose text would be garbage; null for text. */
function refuseNonText(file: TFile, tool: string): ToolResult | null {
  const extension = file.extension.toLowerCase();
  if (isImagePath(file.path)) {
    return { result: `${file.path} is an image; ${tool} reads text only. Use view_image to look at it.`, isError: true };
  }
  if (BINARY_EXTENSIONS.includes(extension)) {
    return { result: `${file.path} is a binary file; ${tool} reads text only.`, isError: true };
  }
  return null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function requiredString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function requiredRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

/** A JSON object; arrays and null are not. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** About 50 characters either side of a match, on one line. */
function snippet(content: string, idx: number, length: number): string {
  const start = Math.max(0, idx - 50);
  const end = Math.min(content.length, idx + length + 50);
  return `...${content.substring(start, end).replace(/\n/g, " ")}...`;
}

/** The canvas file at `path`, or an error result for the model. */
function resolveCanvas(app: App, path: string): TFile | ToolResult {
  if (!path) return { result: "'path' parameter is required.", isError: true };
  if (!isCanvasPath(path)) {
    return { result: `${path} is not a canvas. read_canvas, view_canvas and edit_canvas work on .canvas files; use read_document or edit_document for notes.`, isError: true };
  }
  const file = app.vault.getFileByPath(normalizePath(path));
  return file ?? { result: `File not found: ${path}`, isError: true };
}

// ─── Tool Implementations ───────────────────────────────────────────────────

async function readDocument(
  app: App,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const path = optionalString(input.path);
  const file = resolveFile(app, path);
  if (!file) {
    return { result: path ? `File not found: ${path}` : "No active document open.", isError: true };
  }
  // A PDF or Office file can be read: read_file attaches it.
  if (isDocumentFile(file.path) && !isImagePath(file.path)) {
    return { result: `${file.path} is a PDF or Office file; read_document reads text only. Use read_file, which attaches it.`, isError: true };
  }
  const refusal = refuseNonText(file, "read_document");
  if (refusal) return refusal;

  // cachedRead() is faster for display-only reads
  const content = await app.vault.cachedRead(file);
  return { result: `# ${file.path}\n\n${content}`, isError: false };
}

async function editDocument(
  app: App,
  input: Record<string, unknown>,
  scope: SelectionScope | undefined,
  changes: ChangeLog | undefined
): Promise<ToolResult> {
  const operation = requiredString(input.operation);
  // A missing `content` must not become "": replace_all would blank the
  // note and find_replace would delete the found text, both reported as
  // success. An explicit "" (delete on purpose) is fine.
  if (typeof input.content !== "string") {
    return { result: "'content' is required for edit_document (use \"\" to delete text).", isError: true };
  }
  const content = input.content;
  const find = optionalString(input.find);
  const position = optionalString(input.position);

  const path = optionalString(input.path);
  const file = resolveFile(app, path);
  if (!file) {
    return { result: path ? `File not found: ${path}` : "No active document open.", isError: true };
  }

  if (scope && file.path === scope.filePath) {
    if (operation !== "find_replace") return scopeRefusal(file.path);
    if (!find) return { result: "'find' parameter is required for find_replace.", isError: true };
    return await withChange(app, file, changes, () => editInScope(app, file, scope, find, content));
  }
  return await withChange(app, file, changes, () => applyEdit(app, file, operation, content, find, position));
}

/**
 * Runs a change to `file`, records it in `changes` for undo, and adds what
 * changed (`focus`, unless the change set its own) to its result, for
 * showing it to the user (`ui/show-in-view.ts`).
 */
async function withChange(app: App, file: TFile, changes: ChangeLog | undefined, change: () => Promise<ToolResult>): Promise<ToolResult> {
  const before = await app.vault.cachedRead(file);
  const result = await change();
  if (result.isError) return result;
  const after = await app.vault.cachedRead(file);
  changes?.edited(file.path, before, after);
  const range = result.focus ? null : changedRange(before, after);
  return range ? { ...result, focus: { path: file.path, ...range } } : result;
}

async function applyEdit(
  app: App,
  file: TFile,
  operation: string,
  content: string,
  find: string | undefined,
  position: string | undefined
): Promise<ToolResult> {
  switch (operation) {
    case "replace_all":
      await app.vault.process(file, () => content);
      return { result: `Replaced all content in ${file.path}.`, isError: false };

    case "find_replace": {
      if (!find) {
        return { result: "'find' parameter is required for find_replace.", isError: true };
      }

      // Use vault.process() for atomic read-modify-write
      let resultMsg = "";
      let found = false;

      await app.vault.process(file, (data) => {
        const idx = data.indexOf(find);
        if (idx === -1) {
          found = false;
          return data; // Return unchanged
        }
        found = true;
        const secondIdx = data.indexOf(find, idx + 1);
        if (secondIdx !== -1) {
          resultMsg = "[Note: Multiple matches found, replacing first occurrence.]\n";
        }
        return data.substring(0, idx) + content + data.substring(idx + find.length);
      });

      if (!found) {
        return {
          result: "Could not find the specified text. Make sure it matches exactly (including whitespace and line breaks).",
          isError: true,
        };
      }

      return { result: `${resultMsg}Successfully replaced text in ${file.path}.`, isError: false };
    }

    case "insert": {
      if (!position) {
        return { result: "'position' parameter is required for insert.", isError: true };
      }
      if (position !== "beginning" && position !== "end" && position !== "after_frontmatter") {
        return { result: `Unknown position: ${position}. Use beginning, end or after_frontmatter.`, isError: true };
      }

      await app.vault.process(file, (data) => {
        if (position === "end") return data + "\n" + content;
        // After the frontmatter as Obsidian reads it (0 without one), so a
        // "---" inside a value doesn't count.
        const start = position === "after_frontmatter" ? getFrontMatterInfo(data).contentStart : 0;
        const head = data.substring(0, start);
        // A note that ends right at the closing --- has no line break after it.
        const separator = head && !head.endsWith("\n") ? "\n" : "";
        return head + separator + content + "\n" + data.substring(start);
      });

      return { result: `Inserted content at ${position} of ${file.path}.`, isError: false };
    }

    default:
      return { result: `Unknown operation: ${operation}`, isError: true };
  }
}

async function searchVault(
  app: App,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const query = requiredString(input.query).toLowerCase();
  const searchContent = input.searchContent as boolean | undefined;
  const limit = Math.min((input.limit as number) || 10, 50);

  const canvases = app.vault.getFiles().filter((f) => isCanvasPath(f.path));
  const files = [...app.vault.getMarkdownFiles(), ...canvases];
  const results: string[] = [];
  const touched = new Set<string>();

  for (const file of files) {
    if (results.length >= limit) break;

    if (file.path.toLowerCase().includes(query)) {
      touched.add(file.path);
      results.push(`- ${file.path}`);
      continue;
    }

    if (searchContent && isCanvasPath(file.path)) {
      touched.add(file.path);
      // Card text, group labels and edge labels; positions in the JSON don't count.
      let texts: ReturnType<typeof canvasSearchTexts>;
      try {
        texts = canvasSearchTexts(parseCanvas(await app.vault.cachedRead(file)));
      } catch {
        continue; // Not valid JSON Canvas; nothing searchable.
      }
      for (const { id, kind, text } of texts) {
        if (results.length >= limit) break;
        const idx = text.toLowerCase().indexOf(query);
        if (idx !== -1) results.push(`- ${file.path} (${kind} ${id}): ${snippet(text, idx, query.length)}`);
      }
    } else if (searchContent) {
      touched.add(file.path);
      // cachedRead() avoids redundant disk reads
      const content = await app.vault.cachedRead(file);
      const lowerContent = content.toLowerCase();
      const idx = lowerContent.indexOf(query);
      if (idx !== -1) {
        results.push(`- ${file.path}: ${snippet(content, idx, query.length)}`);
      }
    }
  }

  if (results.length === 0) {
    return { result: `No results found for "${query}".`, isError: false, instructionPaths: [...touched] };
  }

  return {
    result: `Found ${results.length} result(s):\n${results.join("\n")}`,
    isError: false,
    instructionPaths: [...touched],
  };
}

async function readFile(
  app: App,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const path = requiredString(input.path);
  if (!path) {
    return { result: "'path' parameter is required.", isError: true };
  }

  const file = app.vault.getFileByPath(normalizePath(path));
  if (!file) {
    return { result: `File not found: ${path}`, isError: true };
  }

  if (isDocumentFile(file.path)) {
    if (file.stat?.size > MAX_FILE_BYTES) return { result: `${file.path} exceeds the 10 MB file limit.`, isError: true };
    // Check before reading and again in fileAttachment in case the file grew.
    // PDF and Office files go to the model as files (the provider reads them).
    const attachment = await fileAttachment(file.path.slice(file.path.lastIndexOf("/") + 1), await app.vault.readBinary(file));
    if (typeof attachment === "string") return { result: attachment, isError: true };
    return { result: `${file.path} (${formatBytes(attachment.sizeBytes)}) is attached.`, isError: false, files: [attachment] };
  }

  const refusal = refuseNonText(file, "read_file");
  if (refusal) return refusal;

  const content = await app.vault.cachedRead(file);
  return { result: content, isError: false };
}

async function viewImage(
  app: App,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const path = requiredString(input.path);
  if (!path) {
    return { result: "'path' parameter is required.", isError: true };
  }
  const file = app.vault.getFileByPath(normalizePath(path));
  if (!file) {
    return { result: `File not found: ${path}`, isError: true };
  }
  const mediaType = imageMediaType(file.path);
  if (!mediaType) {
    const hint = isCanvasPath(file.path) ? "Use view_canvas for canvases."
      : extensionOf(file.path) === "svg" ? "SVG is text: use read_file."
      : "Other formats (HEIC, BMP, TIFF, AVIF, …) can't be sent; ask the user to convert the image.";
    return { result: `${file.path} is not a PNG, JPEG, GIF or WebP image. ${hint}`, isError: true };
  }

  if (file.stat?.size > MAX_SOURCE_IMAGE_BYTES) return { result: `Can't send ${file.path}: source images must be 20 MiB or smaller; resize the image first.`, isError: true };
  const bytes = await app.vault.readBinary(file);
  let image;
  try {
    image = await fitImage(bytes, mediaType);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { result: `Can't send ${file.path}: ${msg}.`, isError: true };
  }
  const original = `${pixels(image.originalWidth, image.originalHeight)}${formatBytes(bytes.byteLength)}`;
  const sent = !image.reencoded ? "sent unchanged"
    : `sent as ${pixels(image.width, image.height)}${image.mediaType.slice(6).toUpperCase()}, ${formatBytes(image.sizeBytes)}`;
  return {
    result: `${file.path} (${original}), ${sent}.`,
    isError: false,
    images: [{
      id: `view-${Date.now()}`,
      fileName: file.path.slice(file.path.lastIndexOf("/") + 1),
      mediaType: image.mediaType,
      data: image.data,
      sizeBytes: image.sizeBytes,
    }],
  };
}

/** "1200×800, " or nothing when the size is unknown. */
function pixels(width?: number, height?: number): string {
  return width && height ? `${width}×${height}, ` : "";
}

async function readCanvas(
  app: App,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const file = resolveCanvas(app, requiredString(input.path));
  if ("isError" in file) return file;

  let canvas;
  try {
    canvas = parseCanvas(await app.vault.cachedRead(file));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { result: `${file.path} is not valid JSON Canvas (${msg}). Use read_file to see the raw text.`, isError: true };
  }
  return { result: describeCanvas(file.path, canvas), isError: false };
}

async function viewCanvas(
  app: App,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const file = resolveCanvas(app, requiredString(input.path));
  if ("isError" in file) return file;

  let canvas;
  try {
    canvas = parseCanvas(await app.vault.cachedRead(file));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { result: `${file.path} is not valid JSON Canvas (${msg}). Use read_file to see the raw text.`, isError: true };
  }

  // A full ID, or the short tag drawn on an earlier picture.
  const wanted = optionalString(input.focus);
  const focus = wanted && (canvas.nodes.find((n) => n.id === wanted)?.id
    ?? [...shortIds(canvas.nodes)].find(([, tag]) => tag === wanted)?.[0]);
  if (wanted && !focus) {
    return { result: `No node or group with id "${wanted}" in ${file.path}. Use an ID from read_canvas or a tag from an earlier view_canvas legend.`, isError: true };
  }
  const omitted = new Set<string>();
  const instructionPaths = new Set<string>([file.path]);
  const rendered = await renderCanvas(canvas, {
    focus: focus || undefined,
    createSurface: createCanvasElement,
    loadImage: async (path) => {
      const image = app.vault.getFileByPath(normalizePath(path));
      const mediaType = image ? imageMediaType(image.path) : undefined;
      if (!image || !mediaType) return null;
      if (image.stat?.size > PREVIEW_SOURCE_BYTES) { omitted.add(path); return null; }
      instructionPaths.add(image.path);
      const bytes = await app.vault.readBinary(image);
      if (!canvasImageWithinBudget(bytes)) { omitted.add(path); return null; }
      return decodeImage(bytes, mediaType);
    },
  });
  const png = await encodeCanvas(rendered.surface, "image/png");
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  return {
    result: `Picture of ${file.path}: ${rendered.legend}${omitted.size
      ? `\nImage preview omitted (unknown dimensions, over 4 MiPixels, over 8192 px on one side, or over 10 MiB): ${[...omitted].join(", ")}. These nodes show file cards instead.` : ""}`,
    isError: false,
    instructionPaths: [...instructionPaths],
    images: [{
      id: `canvas-${Date.now()}`,
      fileName: `${name}.${png.mediaType === "image/png" ? "png" : "jpg"}`,
      mediaType: png.mediaType,
      data: png.data,
      sizeBytes: png.sizeBytes,
    }],
  };
}

async function editCanvas(
  app: App,
  input: Record<string, unknown>,
  changes: ChangeLog | undefined
): Promise<ToolResult> {
  const file = resolveCanvas(app, requiredString(input.path));
  if ("isError" in file) return file;
  const operations = input.operations;
  if (!Array.isArray(operations) || operations.length === 0) {
    return { result: "'operations' must be a non-empty array.", isError: true };
  }
  return await withChange(app, file, changes, () => applyCanvasEdit(app, file, operations));
}

async function applyCanvasEdit(app: App, file: TFile, operations: unknown[]): Promise<ToolResult> {
  const fileExists = (path: string) => app.vault.getFileByPath(normalizePath(path)) !== null;
  let summary: string[] = [];
  let error = "";
  let changed: string[] = [];
  // All operations apply, or none: on any error the file is left unchanged.
  await app.vault.process(file, (data) => {
    try {
      const canvas = parseCanvas(data);
      const before = new Map(canvas.nodes.map((node) => [node.id, JSON.stringify(node)]));
      summary = applyCanvasOperations(canvas, operations, fileExists);
      // Cards added or changed, for showing them (`focus`).
      changed = canvas.nodes.filter((node) => before.get(node.id) !== JSON.stringify(node)).map((node) => node.id);
      return serializeCanvas(canvas);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return data;
    }
  });

  if (error) {
    return { result: `No changes made to ${file.path}. ${error}`, isError: true };
  }
  return {
    result: `Updated ${file.path}:\n${summary.map((line) => `- ${line}`).join("\n")}`,
    isError: false,
    ...(changed.length ? { focus: { path: file.path, nodes: changed } } : {}),
  };
}

async function createFile(
  app: App,
  input: Record<string, unknown>,
  changes: ChangeLog | undefined
): Promise<ToolResult> {
  const path = normalizePath(requiredString(input.path));
  const content = requiredString(input.content);

  if (!path) {
    return { result: "'path' parameter is required.", isError: true };
  }

  if (app.vault.getFileByPath(path)) {
    return { result: `File already exists: ${path}. Use edit_document to modify it.`, isError: true };
  }

  await ensureParentFolder(app, path, changes);
  await app.vault.create(path, content || "");
  changes?.created(path, content || "");
  return { result: `Created ${path}.`, isError: false, focus: { path, from: 0, to: (content || "").length } };
}

async function listFiles(
  app: App,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const folder = optionalString(input.folder);
  const extension = optionalString(input.extension);

  let files = app.vault.getFiles();

  if (folder) {
    const normalizedFolder = normalizePath(folder);
    files = files.filter((f) =>
      f.path.startsWith(normalizedFolder + "/") || f.path === normalizedFolder
    );
  }

  if (extension) {
    const ext = extension.startsWith(".") ? extension : `.${extension}`;
    files = files.filter((f) => f.path.endsWith(ext));
  }

  const paths = files.map((f) => f.path).sort();
  const capped = paths.slice(0, 100);
  const suffix = paths.length > 100 ? `\n\n(Showing 100 of ${paths.length} files)` : "";

  if (capped.length === 0) {
    return { result: "No files found matching the criteria.", isError: false };
  }

  return {
    result: capped.map((p) => `- ${p}`).join("\n") + suffix,
    isError: false,
    instructionPaths: capped,
  };
}

async function renameFile(
  app: App,
  input: Record<string, unknown>,
  changes: ChangeLog | undefined
): Promise<ToolResult> {
  const path = requiredString(input.path);
  const newPath = requiredString(input.new_path);

  if (!path || !newPath) {
    return { result: "Both 'path' and 'new_path' parameters are required.", isError: true };
  }

  const file = app.vault.getAbstractFileByPath(normalizePath(path));
  if (!file) {
    return { result: `File not found: ${path}`, isError: true };
  }

  const normalizedNew = normalizePath(newPath);

  if (app.vault.getAbstractFileByPath(normalizedNew)) {
    return { result: `A file already exists at: ${normalizedNew}`, isError: true };
  }

  await ensureParentFolder(app, normalizedNew, changes);

  // fileManager.renameFile() updates all internal links automatically
  const from = file.path;
  const recordRename = await changes?.renaming(app, from, normalizedNew);
  await app.fileManager.renameFile(file, normalizedNew);
  await recordRename?.();
  return { result: `Renamed ${path} to ${normalizedNew}.`, isError: false };
}

async function deleteFile(
  app: App,
  input: Record<string, unknown>,
  changes: ChangeLog | undefined
): Promise<ToolResult> {
  const path = requiredString(input.path);
  if (!path) {
    return { result: "'path' parameter is required.", isError: true };
  }

  const file = app.vault.getAbstractFileByPath(normalizePath(path));
  if (!file) {
    return { result: `File not found: ${path}`, isError: true };
  }

  // Kept for undo first; trashFile() respects the user's deletion preference.
  const recordDelete = await changes?.deleting(app, file);
  await app.fileManager.trashFile(file);
  recordDelete?.();
  return { result: `Moved ${path} to trash.`, isError: false };
}

async function getProperties(
  app: App,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const path = optionalString(input.path);
  const file = resolveFile(app, path);
  if (!file) {
    return { result: path ? `File not found: ${path}` : "No active document open.", isError: true };
  }

  const cache = app.metadataCache.getFileCache(file);
  const frontmatter = cache?.frontmatter;

  if (!frontmatter) {
    return { result: `No frontmatter properties found in ${file.path}.`, isError: false };
  }

  // Remove the position metadata that Obsidian adds internally
  const clean = { ...frontmatter };
  delete clean.position;

  return { result: JSON.stringify(clean, null, 2), isError: false };
}

async function setProperties(
  app: App,
  input: Record<string, unknown>,
  changes: ChangeLog | undefined
): Promise<ToolResult> {
  const props = requiredRecord(input.properties);
  if (!props) {
    return { result: "'properties' parameter must be an object.", isError: true };
  }

  const path = optionalString(input.path);
  const file = resolveFile(app, path);
  if (!file) {
    return { result: path ? `File not found: ${path}` : "No active document open.", isError: true };
  }

  return await withChange(app, file, changes, async () => {
    // Use Obsidian's built-in processFrontMatter for safe YAML handling
    await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
      for (const [key, value] of Object.entries(props)) {
        if (value === null) {
          delete frontmatter[key];
        } else {
          frontmatter[key] = value;
        }
      }
    });

    const setKeys = Object.entries(props).filter(([, v]) => v !== null).map(([k]) => k);
    const removedKeys = Object.entries(props).filter(([, v]) => v === null).map(([k]) => k);
    const parts: string[] = [];
    if (setKeys.length > 0) parts.push(`Set: ${setKeys.join(", ")}`);
    if (removedKeys.length > 0) parts.push(`Removed: ${removedKeys.join(", ")}`);

    return { result: `Updated properties in ${file.path}. ${parts.join(". ")}.`, isError: false };
  });
}

async function getNoteLinks(
  app: App,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const path = optionalString(input.path);
  const file = resolveFile(app, path);
  if (!file) {
    return { result: path ? `File not found: ${path}` : "No active document open.", isError: true };
  }
  return getLinks(app, file);
}

function getCurrentDatetime(): ToolResult {
  const now = new Date();
  const iso = now.toISOString();
  const local = now.toLocaleString(undefined, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });
  // YYYY-MM-DD in the user's time zone, as daily notes are named.
  const pad = (n: number) => String(n).padStart(2, "0");
  const dateOnly = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;

  return {
    result: `Local: ${local}\nISO: ${iso}\nDate: ${dateOnly}`,
    isError: false,
  };
}

async function openDocument(
  app: App,
  input: Record<string, unknown>
): Promise<ToolResult> {
  const path = requiredString(input.path);
  if (!path) {
    return { result: "'path' parameter is required.", isError: true };
  }

  const file = app.vault.getFileByPath(normalizePath(path));
  if (!file) {
    return { result: `File not found: ${path}`, isError: true };
  }

  // The spot to show: a text in a note, or a canvas card.
  const text = optionalString(input.text);
  const node = optionalString(input.node_id);
  let found = "";
  let target: ViewTarget = { path: file.path };
  if (node && file.extension === "canvas") {
    target = { path: file.path, nodes: [node] };
    found = ` at card ${node}`;
  } else if (text && file.extension === "md") {
    const content = await app.vault.cachedRead(file);
    let at = content.indexOf(text);
    if (at === -1) at = content.toLowerCase().indexOf(text.toLowerCase());
    if (at !== -1) {
      target = { path: file.path, from: at, to: at + text.length };
      found = " at the text";
    } else {
      found = "; the text wasn't found, so it opened at the top";
    }
  }
  // The user asked to see it: bring it forward, also on a phone.
  await showInView(app, target, { reveal: true });
  return { result: `Showed ${file.path}${found}.`, isError: false };
}

async function askUser(
  input: Record<string, unknown>,
  onAskUser: AskUserCallback
): Promise<ToolResult> {
  const question = requiredString(input.question);
  if (!question) {
    return { result: "'question' parameter is required.", isError: true };
  }

  const answer = await onAskUser(question);
  return { result: answer, isError: false };
}
