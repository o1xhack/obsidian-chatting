import { sha256 } from "@noble/hashes/sha2.js";
import type { SelectionScope } from "./types";
import { isRecord } from "./json";

export function isSavedSelection(value: unknown): value is SelectionScope {
  if (!isRecord(value) || Array.isArray(value) || typeof value.filePath !== "string" || typeof value.text !== "string") return false;
  if ("sourceText" in value && typeof value.sourceText !== "string") return false;
  if ("sourceHash" in value && (typeof value.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceHash))) return false;
  return ["from", "occurrence"].every(key => !(key in value) ||
    (typeof value[key] === "number" && Number.isInteger(value[key]) && value[key] >= 0));
}

/** A compact identity for a normalized editor snapshot, never sent to a model. */
export function selectionHash(text: string): string {
  return Array.from(sha256(new TextEncoder().encode(text.replace(/\r\n/g, "\n"))), byte => byte.toString(16).padStart(2, "0")).join("");
}

/** Full snapshots belong only to the active turn's selection enforcement. */
export function historySelection(selection: SelectionScope): SelectionScope {
  if (selection.sourceText === undefined) return selection;
  const { sourceText, ...rest } = selection;
  return { ...rest, sourceHash: selectionHash(sourceText) };
}
