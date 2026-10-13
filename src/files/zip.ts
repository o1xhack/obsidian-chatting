/**
 * Reads entries of a ZIP archive (Word, Excel and PowerPoint files are
 * ZIPs of XML). Stored and deflated entries; deflate through the
 * platform's `DecompressionStream`, so no library is needed (and it
 * works the same on mobile).
 * No ZIP64, encryption or multi-disk archives (Office doesn't write them
 * for documents of this size).
 */

const END_OF_DIRECTORY = 0x06054b50;

/**
 * What one archive may unpack to, all entries together: far more than an
 * Office file of 10 MB holds, far less than a crafted archive ("zip bomb")
 * can unpack to before Obsidian runs out of memory.
 */
export const MAX_UNPACKED_BYTES = 64 * 1024 * 1024;

/** The unpacked bytes an archive may still use (shared by its entries). */
export interface UnpackBudget {
  left: number;
}

export function unpackBudget(): UnpackBudget {
  return { left: MAX_UNPACKED_BYTES };
}
const DIRECTORY_ENTRY = 0x02014b50;
const LOCAL_HEADER = 0x04034b50;

export interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  localOffset: number;
}

/** The archive's entries by name, from its central directory. */
export function zipEntries(bytes: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end record is in the last 64 KiB (after it only a comment).
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === END_OF_DIRECTORY) {
      end = i;
      break;
    }
  }
  if (end === -1) throw new Error("not a ZIP archive");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const entries = new Map<string, ZipEntry>();
  const decoder = new TextDecoder();
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== DIRECTORY_ENTRY) throw new Error("damaged ZIP directory");
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    entries.set(name, {
      name,
      method: view.getUint16(at + 10, true),
      compressedSize: view.getUint32(at + 20, true),
      localOffset: view.getUint32(at + 42, true),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

/**
 * An entry's bytes, unpacked, within `budget`: past it the unpacking stops
 * and the entry is refused, so a crafted archive can't fill the memory.
 */
export async function zipEntryBytes(bytes: Uint8Array, entry: ZipEntry, budget: UnpackBudget = unpackBudget()): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const at = entry.localOffset;
  if (view.getUint32(at, true) !== LOCAL_HEADER) throw new Error(`damaged ZIP entry ${entry.name}`);
  const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
  const data = bytes.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return take(data, budget, entry);
  if (entry.method !== 8) throw new Error(`unsupported ZIP compression ${entry.method}`);
  const reader = new Blob([data.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw")).getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    try {
      take(value, budget, entry);
    } catch (e) {
      await reader.cancel();
      throw e;
    }
    parts.push(value);
    size += value.byteLength;
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

/** `chunk`, counted against `budget`; throws past it. */
function take(chunk: Uint8Array, budget: UnpackBudget, entry: ZipEntry): Uint8Array {
  budget.left -= chunk.byteLength;
  if (budget.left < 0) throw new Error(`${entry.name} unpacks to more than ${MAX_UNPACKED_BYTES / 1024 / 1024} MB`);
  return chunk;
}

/** An entry as text (UTF-8), or null when the archive doesn't have it. */
export async function zipText(bytes: Uint8Array, entries: Map<string, ZipEntry>, name: string, budget?: UnpackBudget): Promise<string | null> {
  const entry = entries.get(name);
  return entry ? new TextDecoder().decode(await zipEntryBytes(bytes, entry, budget)) : null;
}
