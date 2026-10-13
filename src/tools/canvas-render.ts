/**
 * Draws a JSON Canvas as a picture for the view_canvas tool: groups as
 * labelled boxes, text cards with wrapped plain text, file nodes (images
 * drawn), links, edges with arrows and labels, the colour presets, and a
 * short ID tag on every node. Plain Canvas 2D, so it runs the same on
 * desktop and mobile. The drawing surface and image loading are passed in:
 * the executor uses a <canvas> element and the vault, tests use fakes.
 */
import type { CanvasData, CanvasEdge, CanvasNode } from "./canvas";
import { defaultSides } from "./canvas";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

/** The Canvas 2D calls the renderer uses. */
export type DrawContext = Pick<CanvasRenderingContext2D,
  "fillStyle" | "strokeStyle" | "lineWidth" | "font" | "textBaseline" | "textAlign" |
  "setTransform" | "fillRect" | "beginPath" | "moveTo" | "lineTo" | "arcTo" |
  "bezierCurveTo" | "closePath" | "fill" | "stroke" | "fillText" | "measureText" |
  "drawImage" | "save" | "restore" | "rect" | "clip">;

export interface DrawSurface {
  width: number;
  height: number;
  getContext(contextId: "2d"): DrawContext | null;
}

/** A decoded image, e.g. an ImageBitmap. */
export type LoadedImage = CanvasImageSource & { width: number; height: number; close?: () => void };

export interface RenderOptions<S extends DrawSurface> {
  /** Creates the surface to draw on, already sized. */
  createSurface: (width: number, height: number) => S;
  /** ID of a group or node to zoom to; default: the whole canvas. */
  focus?: string;
  /** Decodes the image file at a vault path; null if it isn't one or can't be read. */
  loadImage?: (path: string) => Promise<LoadedImage | null>;
  /** Longest side of the picture in pixels. */
  maxSide?: number;
}

export interface CanvasLayout {
  /** The part of the canvas shown, in canvas coordinates (with padding). */
  view: Rect;
  /** Pixels per canvas unit. */
  scale: number;
  width: number;
  height: number;
  /** Nodes at least partly inside the view, in drawing order (groups first). */
  visible: CanvasNode[];
  /** The focused node, if any. */
  focus?: CanvasNode;
}

export interface EdgeGeometry {
  from: Point;
  to: Point;
  /** Bezier control points. */
  c1: Point;
  c2: Point;
  /** Middle of the curve, where the label goes. */
  mid: Point;
  fromSide: string;
  toSide: string;
  fromArrow: boolean;
  toArrow: boolean;
}

export const MAX_SIDE = 1600;
/** Space around the content, in canvas units. */
const PADDING = 40;
/** Small canvases or zoomed nodes are enlarged at most this much. */
const MAX_SCALE = 2;
/** Below this scale, card text is too small to read. */
const READABLE_SCALE = 0.5;
/** Images drawn per picture, to bound memory on phones. */
const MAX_IMAGES = 20;
const SIDES = ["top", "right", "bottom", "left"];

/** JSON Canvas presets 1–6: red, orange, yellow, green, cyan, purple (Obsidian's shades). */
export const PRESET_COLORS: Record<string, string> = {
  "1": "#fb464c",
  "2": "#e9973f",
  "3": "#e0de71",
  "4": "#44cf6e",
  "5": "#53dfdd",
  "6": "#a882ff",
};
const BACKGROUND = "#ffffff";
const BORDER = "#9a9a9a";
const TEXT = "#222222";
const MUTED = "#666666";
const EDGE = "#8a8a8a";

const CARD_FONT = 16;
const CARD_LINE = 24;
const CARD_PADDING = 16;
const TAG_FONT = 12;

// ─── Layout ─────────────────────────────────────────────────────────────────

/** Which part of the canvas to show and at what scale. Throws if `focus` isn't a node ID. */
export function canvasLayout(data: CanvasData, focus?: string, maxSide = MAX_SIDE): CanvasLayout {
  const nodes = data.nodes.filter(isDrawable);
  const target = focus ? nodes.find((n) => n.id === focus) : undefined;
  if (focus && !target) throw new Error(`no node or group with id "${focus}"`);
  const content = target ?? boundsOf(nodes) ?? { x: 0, y: 0, width: 400, height: 300 };
  const view = {
    x: content.x - PADDING,
    y: content.y - PADDING,
    width: content.width + 2 * PADDING,
    height: content.height + 2 * PADDING,
  };
  const scale = Math.min(MAX_SCALE, maxSide / Math.max(view.width, view.height));
  const visible = nodes.filter((n) => overlaps(n, view));
  return {
    view,
    scale,
    width: Math.max(1, Math.round(view.width * scale)),
    height: Math.max(1, Math.round(view.height * scale)),
    visible: [...visible.filter((n) => n.type === "group"), ...visible.filter((n) => n.type !== "group")],
    focus: target,
  };
}

/** The tag drawn on each node: IDs up to 8 characters as they are, longer ones (Obsidian's are 16) as their shortest unique prefix of at least 4. */
export function shortIds(nodes: { id: string }[]): Map<string, string> {
  const ids = [...new Set(nodes.map((n) => String(n.id)))].sort();
  const common = (a = "", b = "") => {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  };
  const tags = new Map<string, string>();
  ids.forEach((id, i) => {
    const length = Math.max(4, common(id, ids[i - 1]) + 1, common(id, ids[i + 1]) + 1);
    tags.set(id, id.length <= 8 ? id : id.slice(0, length));
  });
  return tags;
}

/** Where an edge starts and ends, its curve, and which ends get arrows (JSON Canvas defaults: fromEnd none, toEnd arrow). */
export function edgeGeometry(edge: CanvasEdge, nodes: Map<string, CanvasNode>): EdgeGeometry | null {
  const a = nodes.get(edge.fromNode);
  const b = nodes.get(edge.toNode);
  if (!a || !b) return null;
  const sides = defaultSides(a, b);
  const fromSide = typeof edge.fromSide === "string" && SIDES.includes(edge.fromSide) ? edge.fromSide : sides.fromSide;
  const toSide = typeof edge.toSide === "string" && SIDES.includes(edge.toSide) ? edge.toSide : sides.toSide;
  const from = sidePoint(a, fromSide);
  const to = sidePoint(b, toSide);
  const pull = Math.min(150, Math.max(20, Math.hypot(to.x - from.x, to.y - from.y) * 0.4));
  const c1 = offset(from, normal(fromSide), pull);
  const c2 = offset(to, normal(toSide), pull);
  return {
    from, to, c1, c2,
    mid: {
      x: (from.x + 3 * c1.x + 3 * c2.x + to.x) / 8,
      y: (from.y + 3 * c1.y + 3 * c2.y + to.y) / 8,
    },
    fromSide,
    toSide,
    fromArrow: edge.fromEnd === "arrow",
    toArrow: edge.toEnd !== "none",
  };
}

/** A preset ("1"–"6") or hex colour as #rrggbb; undefined if missing or invalid. */
export function colorOf(value: unknown): string | undefined {
  const color = typeof value === "number" ? String(value) : value;
  if (typeof color !== "string") return undefined;
  if (PRESET_COLORS[color]) return PRESET_COLORS[color];
  if (/^#[0-9a-f]{6}$/i.test(color)) return color.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(color)) return `#${[...color.slice(1)].map((c) => c + c).join("")}`.toLowerCase();
  return undefined;
}

/** Card Markdown as plain text, roughly: no heading marks, emphasis, link syntax or code fences. */
export function plainText(markdown: string): string {
  return markdown
    .split("\n")
    .filter((line) => !/^\s*(```|~~~)/.test(line))
    .map((line) => line
      .replace(/^\s{0,3}#{1,6}\s+/, "")
      .replace(/^\s*>\s?/, "")
      .replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+/, "$1☐ ")
      .replace(/^(\s*)[-*+]\s+/, "$1• ")
      .replace(/!?\[\[([^\]|]*)\|([^\]]*)\]\]/g, "$2")
      .replace(/!?\[\[([^\]]*)\]\]/g, "$1")
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/(\*\*|__|~~|==)(.+?)\1/g, "$2")
      .replace(/(^|[^\w*])\*([^*\n]+)\*(?!\w)/g, "$1$2")
      .replace(/`([^`]*)`/g, "$1"))
    .join("\n")
    .trim();
}

/** The legend line for a node: its type and first words. */
export function describeForLegend(node: CanvasNode): string {
  switch (node.type) {
    case "text":
      return `text ${JSON.stringify(firstWords(plainText(str(node.text))))}`;
    case "file":
      return `file ${str(node.file)}${typeof node.subpath === "string" ? node.subpath : ""}`;
    case "link":
      return `link ${str(node.url)}`;
    case "group":
      return `group ${typeof node.label === "string" && node.label ? JSON.stringify(firstWords(node.label)) : "(no label)"}`;
    default:
      return String(node.type);
  }
}

// ─── Drawing ────────────────────────────────────────────────────────────────

export interface RenderResult<S> {
  surface: S;
  layout: CanvasLayout;
  /** Text for the model: what was drawn, and each tag → node. */
  legend: string;
}

/** Draws the canvas (or the focused node or group) and describes what was drawn. */
export async function renderCanvas<S extends DrawSurface>(data: CanvasData, options: RenderOptions<S>): Promise<RenderResult<S>> {
  const layout = canvasLayout(data, options.focus, options.maxSide);
  const { view, scale, width, height, visible } = layout;
  const surface = options.createSurface(width, height);
  const ctx = surface.getContext("2d");
  if (!ctx) throw new Error("drawing is unavailable on this device");

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = BACKGROUND;
  ctx.fillRect(0, 0, width, height);
  ctx.setTransform(scale, 0, 0, scale, -view.x * scale, -view.y * scale);
  /** One output pixel in canvas units, so lines stay visible when zoomed out. */
  const px = 1 / scale;

  let images = 0;
  for (const node of visible) {
    if (node.type === "group") {
      drawGroup(ctx, node, px);
    } else {
      let image: LoadedImage | null = null;
      if (node.type === "file" && options.loadImage && typeof node.file === "string" && !node.subpath
        && images < MAX_IMAGES && Math.min(node.width, node.height) * scale >= 16) {
        image = await options.loadImage(node.file).catch(() => null);
        if (image) images++;
      }
      drawCard(ctx, node, px, image);
      image?.close?.();
    }
  }

  const byId = new Map(data.nodes.filter(isDrawable).map((n) => [n.id, n]));
  let edgeCount = 0;
  for (const edge of data.edges) {
    const geometry = edgeGeometry(edge, byId);
    if (!geometry) continue;
    drawEdge(ctx, edge, geometry, px);
    edgeCount++;
  }

  const tags = shortIds(data.nodes);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  for (const node of visible) {
    drawTag(ctx, tags.get(node.id) ?? node.id, node, layout);
  }

  return { surface, layout, legend: legendText(data, layout, tags, edgeCount) };
}

function legendText(data: CanvasData, layout: CanvasLayout, tags: Map<string, string>, edgeCount: number): string {
  const total = data.nodes.length;
  const shown = layout.focus
    ? `zoomed to ${layout.focus.type} ${layout.focus.id}; ${layout.visible.length} of ${total} node(s) in view`
    : `all ${total} node(s)`;
  const lines = [
    `${layout.width}×${layout.height} px (${shown}, ${edgeCount} edge(s), scale ${round2(layout.scale)}). Each node's tag is drawn at its top-right corner.`,
  ];
  if (layout.scale < READABLE_SCALE) {
    lines.push("Text is small at this scale: call view_canvas again with focus set to a group or node ID to zoom in.");
  }
  lines.push("Nodes (tag: type and first words; full ID in brackets when the tag is shorter):");
  for (const node of layout.visible) {
    const tag = tags.get(node.id) ?? node.id;
    lines.push(`- ${tag}${tag !== node.id ? ` [${node.id}]` : ""}: ${describeForLegend(node)}`);
  }
  if (!layout.visible.length) lines.push("- (none: the canvas is empty)");
  lines.push("Edges are drawn as lines; read_canvas lists them with their labels.");
  return lines.join("\n");
}

function drawGroup(ctx: DrawContext, node: CanvasNode, px: number): void {
  const color = colorOf(node.color);
  roundedRect(ctx, node, 12);
  ctx.fillStyle = tint(color ?? BORDER, color ? 0.1 : 0.06);
  ctx.fill();
  ctx.lineWidth = Math.max(2, px);
  ctx.strokeStyle = color ?? BORDER;
  ctx.stroke();
  if (typeof node.label === "string" && node.label) {
    ctx.font = `bold ${Math.max(20, 12 * px)}px sans-serif`;
    ctx.fillStyle = color ?? MUTED;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText(firstWords(node.label, 12), node.x + 4, node.y - 6);
  }
}

function drawCard(ctx: DrawContext, node: CanvasNode, px: number, image: LoadedImage | null): void {
  const color = colorOf(node.color);
  if (image) {
    // Like Obsidian: the image fills the node, keeping its aspect ratio.
    const fit = Math.min(node.width / image.width, node.height / image.height);
    const w = image.width * fit;
    const h = image.height * fit;
    ctx.drawImage(image, node.x + (node.width - w) / 2, node.y + (node.height - h) / 2, w, h);
    if (color) {
      roundedRect(ctx, node, 8);
      ctx.lineWidth = Math.max(2, px);
      ctx.strokeStyle = color;
      ctx.stroke();
    }
    return;
  }

  roundedRect(ctx, node, 8);
  ctx.fillStyle = BACKGROUND;
  ctx.fill();
  if (color) {
    ctx.fillStyle = tint(color, 0.12);
    ctx.fill();
  }
  ctx.lineWidth = Math.max(2, px);
  ctx.strokeStyle = color ?? BORDER;
  ctx.stroke();

  const lines: { text: string; bold?: boolean; muted?: boolean }[] = [];
  if (node.type === "text") {
    lines.push({ text: plainText(str(node.text)) });
  } else if (node.type === "file") {
    const path = str(node.file);
    const name = path.slice(path.lastIndexOf("/") + 1);
    lines.push({ text: `${name}${typeof node.subpath === "string" ? node.subpath : ""}`, bold: true });
    if (name !== path) lines.push({ text: path, muted: true });
  } else if (node.type === "link") {
    lines.push({ text: "Link", muted: true }, { text: str(node.url) });
  } else {
    lines.push({ text: String(node.type), muted: true });
  }

  ctx.save();
  ctx.beginPath();
  ctx.rect(node.x, node.y, node.width, node.height);
  ctx.clip();
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  const inner = node.width - 2 * CARD_PADDING;
  let y = node.y + CARD_PADDING;
  const bottom = node.y + node.height - CARD_PADDING;
  for (const part of lines) {
    // The first line is always drawn, even on a card too small for it.
    const room = y === node.y + CARD_PADDING ? Math.max(1, Math.floor((bottom - y) / CARD_LINE)) : Math.floor((bottom - y) / CARD_LINE);
    if (room < 1) break;
    ctx.font = `${part.bold ? "bold " : ""}${CARD_FONT}px sans-serif`;
    ctx.fillStyle = part.muted ? MUTED : TEXT;
    for (const line of wrapText(ctx, part.text, inner, room)) {
      ctx.fillText(line, node.x + CARD_PADDING, y);
      y += CARD_LINE;
    }
  }
  ctx.restore();
}

function drawEdge(ctx: DrawContext, edge: CanvasEdge, g: EdgeGeometry, px: number): void {
  const color = colorOf(edge.color) ?? EDGE;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(2, 1.5 * px);
  ctx.beginPath();
  ctx.moveTo(g.from.x, g.from.y);
  ctx.bezierCurveTo(g.c1.x, g.c1.y, g.c2.x, g.c2.y, g.to.x, g.to.y);
  ctx.stroke();
  const size = Math.max(14, 8 * px);
  if (g.toArrow) arrowHead(ctx, g.to, g.toSide, size);
  if (g.fromArrow) arrowHead(ctx, g.from, g.fromSide, size);

  if (typeof edge.label === "string" && edge.label) {
    const label = firstWords(edge.label, 10);
    ctx.font = `${Math.max(14, 11 * px)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const w = ctx.measureText(label).width + 12 * Math.max(1, px);
    const h = Math.max(22, 16 * px);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(g.mid.x - w / 2, g.mid.y - h / 2, w, h);
    ctx.fillStyle = TEXT;
    ctx.fillText(label, g.mid.x, g.mid.y);
  }
}

/** An arrow pointing into the node at `tip`, which sits on the node's `side`. */
function arrowHead(ctx: DrawContext, tip: Point, side: string, size: number): void {
  const out = normal(side);
  const base = offset(tip, out, size);
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(base.x - out.y * size / 2, base.y + out.x * size / 2);
  ctx.lineTo(base.x + out.y * size / 2, base.y - out.x * size / 2);
  ctx.closePath();
  ctx.fill();
}

/** The tag in screen pixels at the node's top-right corner, kept inside the picture. */
function drawTag(ctx: DrawContext, tag: string, node: CanvasNode, layout: CanvasLayout): void {
  const { view, scale, width, height } = layout;
  ctx.font = `bold ${TAG_FONT}px sans-serif`;
  const w = ctx.measureText(tag).width + 8;
  const h = TAG_FONT + 6;
  const right = Math.min(width, (node.x + node.width - view.x) * scale - 3);
  const x = Math.max(0, right - w);
  const y = Math.min(height - h, Math.max(0, (node.y - view.y) * scale + 3));
  ctx.fillStyle = "#333333";
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "left";
  ctx.textBaseline = "middle";
  ctx.fillText(tag, x + 4, y + h / 2);
}

/** Word-wrapped lines that fit `maxWidth`, at most `maxLines` (the last ends with … if cut). */
export function wrapText(ctx: Pick<DrawContext, "measureText">, text: string, maxWidth: number, maxLines: number): string[] {
  const fits = (s: string) => ctx.measureText(s).width <= maxWidth;
  const lines: string[] = [];
  for (const paragraph of text.split("\n")) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (fits(candidate)) {
        line = candidate;
        continue;
      }
      if (line) lines.push(line);
      // A word wider than the card is broken by characters.
      let rest = word;
      while (!fits(rest) && rest.length > 1) {
        let cut = rest.length - 1;
        while (cut > 1 && !fits(rest.slice(0, cut))) cut--;
        lines.push(rest.slice(0, cut));
        rest = rest.slice(cut);
      }
      line = rest;
    }
    lines.push(line);
    if (lines.length > maxLines) break;
  }
  while (lines.length && !lines[lines.length - 1]) lines.pop();
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = `${kept[maxLines - 1]}…`;
  while (last.length > 1 && !fits(last)) last = `${last.slice(0, -2)}…`;
  kept[maxLines - 1] = last;
  return kept;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isDrawable(node: CanvasNode): boolean {
  return [node.x, node.y, node.width, node.height].every((v) => typeof v === "number" && Number.isFinite(v))
    && node.width > 0 && node.height > 0;
}

function boundsOf(nodes: Rect[]): Rect | undefined {
  if (!nodes.length) return undefined;
  const left = Math.min(...nodes.map((n) => n.x));
  const top = Math.min(...nodes.map((n) => n.y));
  const right = Math.max(...nodes.map((n) => n.x + n.width));
  const bottom = Math.max(...nodes.map((n) => n.y + n.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

function sidePoint(node: Rect, side: string): Point {
  switch (side) {
    case "top": return { x: node.x + node.width / 2, y: node.y };
    case "bottom": return { x: node.x + node.width / 2, y: node.y + node.height };
    case "left": return { x: node.x, y: node.y + node.height / 2 };
    default: return { x: node.x + node.width, y: node.y + node.height / 2 };
  }
}

/** Unit vector pointing out of a node's side. */
function normal(side: string): Point {
  switch (side) {
    case "top": return { x: 0, y: -1 };
    case "bottom": return { x: 0, y: 1 };
    case "left": return { x: -1, y: 0 };
    default: return { x: 1, y: 0 };
  }
}

function offset(p: Point, direction: Point, distance: number): Point {
  return { x: p.x + direction.x * distance, y: p.y + direction.y * distance };
}

function roundedRect(ctx: DrawContext, r: Rect, radius: number): void {
  const rad = Math.min(radius, r.width / 2, r.height / 2);
  ctx.beginPath();
  ctx.moveTo(r.x + rad, r.y);
  ctx.arcTo(r.x + r.width, r.y, r.x + r.width, r.y + r.height, rad);
  ctx.arcTo(r.x + r.width, r.y + r.height, r.x, r.y + r.height, rad);
  ctx.arcTo(r.x, r.y + r.height, r.x, r.y, rad);
  ctx.arcTo(r.x, r.y, r.x + r.width, r.y, rad);
  ctx.closePath();
}

function tint(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function firstWords(text: string, count = 8): string {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length > count ? `${words.slice(0, count).join(" ")}…` : words.join(" ");
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
