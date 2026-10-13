// Rewrites the math delimiters models often use into the ones Obsidian
// renders ($...$ and $$...$$), and escapes the pipe of a [[link|alias]] in a
// table row (Obsidian needs [[link\|alias]] there; models rarely write it).
// Applied at render time only; stored messages stay unchanged. Adapted from
// src/ui/math-markdown.ts in nagisa525/obsidian-chatting-plus (MIT).

const FENCE_OPEN = /^( {0,3})(`{3,}|~{3,})(.*)$/;
const MATH_INFO = /^\s*(?:math|latex|tex)\s*$/i;
// Inline code spans: a backtick run closed by a run of the same length.
const CODE_SPAN = /(`+)[^\n]*?\1(?!`)/g;
// An escaped backslash is matched first, so `\\[` or `\\(` (e.g. a LaTeX
// line break like `\\[2pt]`) is never taken for an opening delimiter.
const DISPLAY = /\\\\|\\\[([\s\S]*?)\\\]/g;
const INLINE = /\\\\|\\\(([^\n]*?)\\\)/g;
// A table row, and the unescaped alias pipe of a wiki link in it.
const TABLE_ROW = /^[ \t]*\|.*$/gm;
const LINK_ALIAS = /(\[\[[^\]|\n]*[^\]|\\\n])\|([^\]\n]*\]\])/g;

export function normalizeMathMarkdown(source: string): string {
  // Line endings are unified, so a CRLF fence is still recognized.
  const lines = source.split(/\r?\n/);
  const out: string[] = [];
  let prose: string[] = [];
  const flushProse = () => {
    if (prose.length > 0) out.push(normalizeProse(prose.join("\n")));
    prose = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i]);
    // A backtick fence's info string can't contain backticks (CommonMark).
    if (!open || (open[2][0] === "`" && open[3].includes("`"))) {
      prose.push(lines[i]);
      continue;
    }
    const [, indent, fence, info] = open;
    let end = i + 1;
    while (end < lines.length && !closesFence(lines[end], fence)) end++;
    const body = lines.slice(i + 1, end);
    flushProse();

    if (end < lines.length && MATH_INFO.test(info) && body.join("").trim()) {
      while (!body[0].trim()) body.shift();
      while (!body[body.length - 1].trim()) body.pop();
      out.push(`${indent}$$`, ...body, `${indent}$$`);
    } else {
      // Ordinary code (or an unclosed fence, which runs to the end) is kept as is.
      out.push(...lines.slice(i, end + 1));
    }
    i = end;
  }
  flushProse();
  return out.join("\n");
}

function closesFence(line: string, fence: string): boolean {
  const close = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(line);
  return close !== null && close[1][0] === fence[0] && close[1].length >= fence.length;
}

function normalizeProse(text: string): string {
  let result = "";
  let cursor = 0;
  for (const span of text.matchAll(CODE_SPAN)) {
    const index = span.index ?? 0;
    result += normalizeDelimiters(text.slice(cursor, index)) + span[0];
    cursor = index + span[0].length;
  }
  return result + normalizeDelimiters(text.slice(cursor));
}

function normalizeDelimiters(text: string): string {
  return text
    .replace(TABLE_ROW, (row) => row.replace(LINK_ALIAS, "$1\\|$2"))
    // Display math keeps its own spacing and line breaks, so a block written
    // on its own lines stays a block (also inside list items).
    .replace(DISPLAY, (match, expression: string | undefined) =>
      expression?.trim() ? `$$${expression}$$` : match)
    // Obsidian needs inline math to touch its dollar signs: `$x$`, not `$ x $`.
    .replace(INLINE, (match, expression: string | undefined) =>
      expression?.trim() ? `$${expression.trim()}$` : match);
}
