import { App, TFile, getAllTags, normalizePath } from "obsidian";
import type { ToolResult } from "../types";

/**
 * Notes by their tags and properties, from Obsidian's metadata cache
 * (no file is read): `query_notes` filters, `list_metadata` shows which
 * tags and properties the vault uses.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const MAX_LISTED = 200;

/** A JSON object; arrays and null are not. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A tag as compared: lower case with its `#`. */
function tagKey(tag: string): string {
  const trimmed = tag.trim().toLowerCase();
  return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

/** The note's tags (body and frontmatter), as Obsidian lists them. */
function tagsOf(app: App, file: TFile): string[] {
  const cache = app.metadataCache.getFileCache(file);
  return cache ? [...new Set(getAllTags(cache) ?? [])] : [];
}

function propertiesOf(app: App, file: TFile): Record<string, unknown> {
  const frontmatter: unknown = app.metadataCache.getFileCache(file)?.frontmatter;
  if (!isRecord(frontmatter)) return {};
  const { position: _position, ...properties } = frontmatter;
  return properties;
}

/** `#project` matches `#project` and nested tags such as `#project/alpha`. */
function hasTag(tags: string[], wanted: string): boolean {
  return tags.some((tag) => {
    const key = tagKey(tag);
    return key === wanted || key.startsWith(`${wanted}/`);
  });
}

/** A value as compared: lower case text, a link without its brackets. */
function comparable(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return text.trim().replace(/^\[\[([^\]|]*)(\|[^\]]*)?\]\]$/, "$1").toLowerCase();
}

/** The property under `key` (exact name first, else ignoring case). */
function property(properties: Record<string, unknown>, key: string): { found: boolean; value: unknown } {
  if (key in properties) return { found: true, value: properties[key] };
  const match = Object.keys(properties).find((name) => name.toLowerCase() === key.toLowerCase());
  return match ? { found: true, value: properties[match] } : { found: false, value: undefined };
}

/** null: the property is set (not empty); a value: equal, or in a list property. */
function matchesProperty(properties: Record<string, unknown>, key: string, wanted: unknown): boolean {
  const { found, value } = property(properties, key);
  if (!found) return false;
  if (wanted === null) return value !== null && value !== "" && !(Array.isArray(value) && value.length === 0);
  const values: unknown[] = Array.isArray(value) ? value : [value];
  return values.some((item) => comparable(item) === comparable(wanted));
}

function inFolder(path: string, folder: string | undefined): boolean {
  if (!folder) return true;
  const prefix = normalizePath(folder).replace(/\/+$/, "");
  return prefix === "" || prefix === "/" || path.startsWith(`${prefix}/`);
}

function show(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

/** Sort key of a property value: numbers and dates in order, text by case. */
function sortValue(value: unknown): string | number {
  if (typeof value === "number") return value;
  if (Array.isArray(value)) return sortValue(value[0]);
  return comparable(value);
}

export function queryNotes(app: App, input: Record<string, unknown>): ToolResult {
  const tags = Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string" && tag.trim() !== "").map(tagKey) : [];
  const anyTag = input.match === "any";
  const filters = isRecord(input.properties) ? Object.entries(input.properties) : [];
  const folder = typeof input.folder === "string" ? input.folder : undefined;
  const sortBy = typeof input.sort_by === "string" && input.sort_by ? input.sort_by : "path";
  const limit = Math.min(typeof input.limit === "number" && input.limit > 0 ? Math.floor(input.limit) : DEFAULT_LIMIT, MAX_LIMIT);
  if (tags.length === 0 && filters.length === 0 && !folder) {
    return { result: "Give at least one of 'tags', 'properties' or 'folder'. To see which tags and properties exist, use list_metadata.", isError: true };
  }

  const matches = app.vault.getMarkdownFiles()
    .filter((file) => inFolder(file.path, folder))
    .map((file) => ({ file, tags: tagsOf(app, file), properties: propertiesOf(app, file) }))
    .filter((note) => tags.length === 0 || (anyTag ? tags.some((tag) => hasTag(note.tags, tag)) : tags.every((tag) => hasTag(note.tags, tag))))
    .filter((note) => filters.every(([key, wanted]) => matchesProperty(note.properties, key, wanted)));

  if (sortBy === "modified") {
    matches.sort((a, b) => b.file.stat.mtime - a.file.stat.mtime);
  } else if (sortBy === "path") {
    matches.sort((a, b) => a.file.path.localeCompare(b.file.path));
  } else {
    // By a property, ascending; notes without it last.
    const key = (note: typeof matches[number]) => property(note.properties, sortBy);
    matches.sort((a, b) => {
      const [x, y] = [key(a), key(b)];
      if (!x.found || !y.found) return Number(!x.found) - Number(!y.found);
      const [p, q] = [sortValue(x.value), sortValue(y.value)];
      return typeof p === "number" && typeof q === "number" ? p - q : String(p).localeCompare(String(q));
    });
  }

  if (matches.length === 0) return { result: "No notes match.", isError: false };
  // Shown with each note: its tags, and the properties asked about or sorted by.
  const shownKeys = [...new Set([...filters.map(([key]) => key), ...(sortBy === "path" || sortBy === "modified" ? [] : [sortBy])])];
  const lines = matches.slice(0, limit).map(({ file, tags: noteTags, properties }) => {
    const details = [
      ...(noteTags.length ? [`tags: ${noteTags.join(" ")}`] : []),
      ...shownKeys.flatMap((key) => {
        const { found, value } = property(properties, key);
        return found ? [`${key}: ${show(value)}`] : [];
      }),
    ];
    return `- ${file.path}${details.length ? ` (${details.join("; ")})` : ""}`;
  });
  const more = matches.length > limit ? `\n\n(Showing ${limit} of ${matches.length} notes.)` : "";
  return { result: `${matches.length} note(s):\n${lines.join("\n")}${more}`, isError: false };
}

export function listMetadata(app: App, input: Record<string, unknown>): ToolResult {
  const folder = typeof input.folder === "string" ? input.folder : undefined;
  const tagCounts = new Map<string, number>();
  const propertyCounts = new Map<string, { count: number; example: unknown }>();
  for (const file of app.vault.getMarkdownFiles()) {
    if (!inFolder(file.path, folder)) continue;
    for (const tag of tagsOf(app, file)) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    for (const [key, value] of Object.entries(propertiesOf(app, file))) {
      const seen = propertyCounts.get(key);
      propertyCounts.set(key, { count: (seen?.count ?? 0) + 1, example: seen?.example ?? value });
    }
  }
  const byCount = <T extends { count: number }>(entries: [string, T][]) =>
    entries.sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
  const tags = byCount([...tagCounts].map(([tag, count]): [string, { count: number }] => [tag, { count }]));
  const properties = byCount([...propertyCounts]);
  const cut = (total: number) => (total > MAX_LISTED ? ` (the ${MAX_LISTED} most used of ${total})` : "");
  const parts = [
    tags.length ? `Tags${cut(tags.length)}:\n${tags.slice(0, MAX_LISTED).map(([tag, { count }]) => `- ${tag} (${count})`).join("\n")}` : "No tags.",
    properties.length
      ? `Properties${cut(properties.length)}:\n${properties.slice(0, MAX_LISTED).map(([key, { count, example }]) => `- ${key} (${count}), e.g. ${show(example).slice(0, 60)}`).join("\n")}`
      : "No properties.",
  ];
  return { result: parts.join("\n\n"), isError: false };
}
