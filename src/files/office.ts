import { unpackBudget, zipEntries, zipText } from "./zip";

/**
 * The text of Word, Excel and PowerPoint files (docx, xlsx, pptx), for
 * providers that can't read them themselves (Anthropic). Reads
 * their XML with patterns, not a parser: these files are machine-written
 * and the patterns work the same on every platform (Node in the tests
 * has no DOMParser). Images, charts and formatting beyond headings,
 * lists and tables are left out.
 */

/** Rows read per sheet. */
const SHEET_ROWS = 2000;

export type OfficeKind = "docx" | "xlsx" | "pptx";

export function officeKind(fileName: string): OfficeKind | null {
  const extension = fileName.slice(fileName.lastIndexOf(".") + 1).toLowerCase();
  return extension === "docx" || extension === "xlsx" || extension === "pptx" ? extension : null;
}

/** The file's text as Markdown. Throws for a damaged file. */
export async function officeText(bytes: Uint8Array, kind: OfficeKind): Promise<string> {
  const entries = zipEntries(bytes);
  // One budget for the whole file: a crafted file can't unpack without end.
  const budget = unpackBudget();
  const read = (name: string) => zipText(bytes, entries, name, budget);
  if (kind === "docx") {
    const xml = await read("word/document.xml");
    if (xml === null) throw new Error("no word/document.xml");
    return docxText(xml);
  }
  if (kind === "pptx") {
    const slides = [...entries.keys()]
      .map((name) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(name))
      .filter((match): match is RegExpExecArray => !!match)
      .sort((a, b) => Number(a[1]) - Number(b[1]));
    const parts: string[] = [];
    for (const [name, number] of slides) {
      const lines = paragraphs(await read(name) ?? "", "a");
      parts.push(`## Slide ${number}${lines.length ? `\n${lines.join("\n")}` : ""}`);
    }
    return parts.join("\n\n");
  }
  return await xlsxText(read);
}

// ─── XML helpers ────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
    return ENTITIES[name] ?? whole;
  });
}

function all(xml: string, pattern: RegExp): string[] {
  return [...xml.matchAll(pattern)].map((match) => match[0]);
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? decode(match[1]) : undefined;
}

/** A run of text in namespace `ns` (w: Word, a: PowerPoint): its texts, tabs and breaks. */
function runText(xml: string, ns: string): string {
  const pattern = new RegExp(`<${ns}:t(?:\\s[^>]*)?>([^<]*)</${ns}:t>|<${ns}:tab\\s*/>|<${ns}:br\\s*/>`, "g");
  let text = "";
  for (const match of xml.matchAll(pattern)) {
    text += match[1] !== undefined ? decode(match[1]) : match[0].includes(":tab") ? "\t" : "\n";
  }
  return text;
}

/** The non-empty paragraphs of `xml` in namespace `ns`. */
function paragraphs(xml: string, ns: string): string[] {
  return all(xml, new RegExp(`<${ns}:p\\b[\\s\\S]*?</${ns}:p>`, "g"))
    .map((p) => runText(p, ns).trim())
    .filter(Boolean);
}

// ─── Word ───────────────────────────────────────────────────────────────────

function docxParagraph(p: string): string {
  const text = runText(p, "w").trim();
  if (!text) return "";
  // Heading style IDs: "Heading2", in German templates "berschrift2" (the Ü is dropped).
  const style = /<w:pStyle w:val="([^"]*)"/.exec(p)?.[1] ?? "";
  const level = /^(?:heading|berschrift|titre|kop)\s*(\d)$/i.exec(style)?.[1];
  const heading = level ? Number(level) : style === "Title" ? 1 : 0;
  if (heading) return `${"#".repeat(Math.min(heading, 6))} ${text}`;
  if (p.includes("<w:numPr>")) return `- ${text}`;
  return text;
}

function docxTable(table: string): string {
  const rows = all(table, /<w:tr\b[\s\S]*?<\/w:tr>/g).map((row) =>
    all(row, /<w:tc\b[\s\S]*?<\/w:tc>/g).map((cell) => paragraphs(cell, "w").join(" ").replace(/\|/g, "\\|")));
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((row) => row.length));
  const line = (cells: string[]) => `| ${[...cells, ...Array<string>(width - cells.length).fill("")].join(" | ")} |`;
  return [line(rows[0]), line(Array<string>(width).fill("---")), ...rows.slice(1).map(line)].join("\n");
}

function docxText(xml: string): string {
  const blocks = all(xml, /<w:tbl\b[\s\S]*?<\/w:tbl>|<w:p\b[^>]*\/>|<w:p\b[\s\S]*?<\/w:p>/g);
  return blocks
    .map((block) => (block.startsWith("<w:tbl") ? docxTable(block) : docxParagraph(block)))
    .filter(Boolean)
    .join("\n\n");
}

// ─── Excel ──────────────────────────────────────────────────────────────────

/** Column letters to a 0-based index ("A" 0, "AA" 26). */
function columnIndex(reference: string): number {
  const letters = /^[A-Z]+/.exec(reference)?.[0] ?? "A";
  return [...letters].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
}

function csvValue(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value;
}

async function xlsxText(read: (name: string) => Promise<string | null>): Promise<string> {
  const shared = all(await read("xl/sharedStrings.xml") ?? "", /<si>[\s\S]*?<\/si>/g)
    .map((si) => [...si.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => decode(m[1])).join(""));
  const workbook = await read("xl/workbook.xml") ?? "";
  const rels = await read("xl/_rels/workbook.xml.rels") ?? "";
  const targets = new Map(all(rels, /<Relationship\b[^>]*>/g).map((tag) => [attribute(tag, "Id") ?? "", attribute(tag, "Target") ?? ""]));

  const parts: string[] = [];
  for (const tag of all(workbook, /<sheet\b[^>]*>/g)) {
    const name = attribute(tag, "name") ?? "Sheet";
    const target = targets.get(attribute(tag, "r:id") ?? "") ?? "";
    const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
    const sheet = await read(path);
    if (sheet === null) continue;
    const rows = all(sheet, /<row\b[\s\S]*?<\/row>/g);
    const lines = rows.slice(0, SHEET_ROWS).map((row) => {
      const cells: string[] = [];
      for (const cell of all(row, /<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g)) {
        const open = /<c\b[^>]*>/.exec(cell)?.[0] ?? "";
        const type = attribute(open, "t");
        const raw = /<v>([^<]*)<\/v>/.exec(cell)?.[1];
        const value = type === "s" ? shared[Number(raw)] ?? ""
          : type === "inlineStr" ? [...cell.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map((m) => decode(m[1])).join("")
          : type === "b" ? (raw === "1" ? "TRUE" : "FALSE")
          : decode(raw ?? "");
        cells[columnIndex(attribute(open, "r") ?? "")] = value;
      }
      return Array.from(cells, (value) => csvValue(value ?? "")).join(",");
    }).filter((line) => line.replace(/,/g, "") !== "");
    const more = rows.length > SHEET_ROWS ? `\n(${rows.length - SHEET_ROWS} more rows not read)` : "";
    parts.push(`## Sheet: ${name}\n${lines.join("\n")}${more}`);
  }
  return parts.join("\n\n");
}
