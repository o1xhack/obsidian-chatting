import { arrayBufferToBase64 } from "obsidian";
import type { FileAttachment } from "../types";
import { officeKind, officeText } from "./office";

/**
 * Files for the model: PDFs and Office documents go to the provider as
 * files where it reads them itself (OpenAI and the ChatGPT account: PDF
 * and Office; Anthropic: PDF); Anthropic gets the text of Word, Excel and
 * PowerPoint files, read here, because it doesn't read those formats.
 * Text files go as text to all.
 */

/** Largest file sent. Anthropic takes 32 MB per request, OpenAI 50 MB. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
/** Text kept of a text file or read from an Office file. */
export const FILE_TEXT_CHARS = 100000;

/** Types the providers read as files, by extension. */
const DOCUMENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  ppt: "application/vnd.ms-powerpoint",
  odt: "application/vnd.oasis.opendocument.text",
  rtf: "application/rtf",
};

/** Read as text, whatever their content. */
const TEXT_EXTENSIONS = new Set([
  "txt", "md", "markdown", "csv", "tsv", "json", "jsonl", "xml", "html", "htm", "yaml", "yml", "toml", "ini", "log",
  "js", "mjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "c", "h", "cpp", "hpp", "cs", "swift", "php",
  "sh", "ps1", "bat", "sql", "css", "scss", "svg", "tex", "bib", "srt", "vtt", "canvas", "base",
]);

function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

/** A file the providers read as a document (PDF, Office). */
export function isDocumentFile(name: string): boolean {
  return extensionOf(name) in DOCUMENT_TYPES;
}

/** The `accept` list of the attach button's file picker (images are added there). */
export const ACCEPTED_FILES = [...Object.keys(DOCUMENT_TYPES), ...TEXT_EXTENSIONS].map((extension) => `.${extension}`).join(",");

function capped(text: string): string {
  return text.length > FILE_TEXT_CHARS ? `${text.slice(0, FILE_TEXT_CHARS)}\n(cut after ${FILE_TEXT_CHARS} of ${text.length} characters)` : text;
}

/** Text if the bytes are UTF-8 text (no NUL, decodes cleanly), else null. */
function asText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

let fileCount = 0;

/**
 * A file for the model, or the reason it can't be sent: too large, or
 * neither a document nor text.
 */
export async function fileAttachment(fileName: string, buffer: ArrayBuffer): Promise<FileAttachment | string> {
  if (buffer.byteLength > MAX_FILE_BYTES) {
    return `${fileName} is ${Math.round(buffer.byteLength / 1024 / 1024)} MB; files can be up to ${MAX_FILE_BYTES / 1024 / 1024} MB.`;
  }
  const bytes = new Uint8Array(buffer);
  const id = `file-${Date.now().toString(36)}-${(fileCount++).toString(36)}`;
  const extension = extensionOf(fileName);
  const mediaType = DOCUMENT_TYPES[extension];
  if (mediaType) {
    // Office text, for providers that don't read the file (Anthropic).
    const kind = officeKind(fileName);
    let text: string | undefined;
    if (kind) {
      try {
        text = capped(await officeText(bytes, kind));
      } catch {
        text = undefined;
      }
    }
    return { id, fileName, mediaType, data: arrayBufferToBase64(buffer), sizeBytes: buffer.byteLength, ...(text !== undefined ? { text } : {}) };
  }
  // Any other file that is text (code, notes, data) goes as its text.
  const text = asText(bytes);
  if (text === null) return `${fileName} can't be sent: only PDF, Word, Excel, PowerPoint and text files (and images) can.`;
  return { id, fileName, mediaType: "text/plain", data: "", sizeBytes: buffer.byteLength, text: capped(text) };
}

/** A text file (or one sent as its text): the text in a frame naming the file. */
export function fileAsText(file: FileAttachment): string {
  return `<file name="${file.fileName}">\n${file.text ?? ""}\n</file>`;
}

/** Sent as a file (PDF, Office), not as text. */
export function isSentAsFile(file: FileAttachment): boolean {
  return file.mediaType !== "text/plain" && !!file.data;
}
