/**
 * JSON Canvas 1.0 (https://jsoncanvas.org/spec/1.0/) helpers for the
 * read_canvas and edit_canvas tools and canvas search. Pure functions: the
 * executor does the vault I/O. Unknown fields on the canvas, its nodes and
 * its edges are kept as they are.
 */

export interface CanvasNode {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  [key: string]: unknown;
}

export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  [key: string]: unknown;
}

export interface CanvasData {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  [key: string]: unknown;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

const NODE_TYPES = ["text", "file", "link", "group"];
const SIDES = ["top", "right", "bottom", "left"];
const ENDS = ["none", "arrow"];
/** Space between a new node and its neighbours. */
const GAP = 40;
/** Space between a group's border and the nodes inside it. */
const GROUP_PADDING = 20;
const TEXT_PREVIEW = 200;

export function isCanvasPath(path: string): boolean {
  return path.toLowerCase().endsWith(".canvas");
}

export function parseCanvas(raw: string): CanvasData {
  if (!raw.trim()) return { nodes: [], edges: [] };
  const data: unknown = JSON.parse(raw);
  if (!isRecord(data)) throw new Error("not a JSON Canvas object");
  const nodes = data.nodes ?? [];
  const edges = data.edges ?? [];
  if (!isRecordList(nodes) || !isRecordList(edges)) {
    throw new Error("'nodes' and 'edges' must be arrays of objects");
  }
  // Spreading keeps the original key order; missing arrays are appended.
  // The fields the spec requires are trusted, as Obsidian wrote them.
  return { ...data, nodes: nodes as CanvasNode[], edges: edges as CanvasEdge[] };
}

/** Serializes like Obsidian: tab indentation, one node or edge per line, no trailing newline. */
export function serializeCanvas(data: CanvasData): string {
  const lines = Object.entries(data).map(([key, value]) => {
    const body = Array.isArray(value) && value.length > 0
      ? `[\n${value.map((item) => `\t\t${JSON.stringify(item)}`).join(",\n")}\n\t]`
      : JSON.stringify(value);
    return `\t${JSON.stringify(key)}:${body}`;
  });
  return `{\n${lines.join(",\n")}\n}`;
}

// ─── Reading ────────────────────────────────────────────────────────────────

/** Compact text view: groups with their nodes, ungrouped nodes, then edges. */
export function describeCanvas(path: string, data: CanvasData): string {
  const { nodes, edges } = data;
  const groups = nodes.filter((n) => n.type === "group");
  const parent = new Map<string, CanvasNode>();
  for (const node of nodes) {
    const group = containingGroups(node, nodes)[0];
    if (group) parent.set(node.id, group);
  }

  const lines = [
    `${path}: ${nodes.length} node(s), ${edges.length} edge(s). Positions are the top-left x,y; sizes are width×height.`,
  ];
  for (const group of groups) {
    const outer = parent.get(group.id);
    lines.push("", `${describeNode(group)}${outer ? ` (inside group ${outer.id})` : ""}`);
    const members = nodes.filter((n) => parent.get(n.id) === group);
    lines.push(...(members.length ? members.map((n) => `  - ${describeNode(n)}`) : ["  (empty)"]));
  }
  const loose = nodes.filter((n) => n.type !== "group" && !parent.has(n.id));
  if (loose.length) {
    lines.push("", groups.length ? "Not in a group:" : "Nodes:", ...loose.map((n) => `  - ${describeNode(n)}`));
  }
  if (edges.length) {
    lines.push("", "Edges:", ...edges.map((e) => `  - ${describeEdge(e)}`));
  }
  if (!nodes.length && !edges.length) lines.push("", "The canvas is empty.");
  return lines.join("\n");
}

function describeNode(node: CanvasNode): string {
  let content: string;
  switch (node.type) {
    case "text":
      content = `text ${preview(asText(node.text))}`;
      break;
    case "file":
      content = `file ${asText(node.file)}${typeof node.subpath === "string" ? node.subpath : ""}`;
      break;
    case "link":
      content = `link ${asText(node.url)}`;
      break;
    case "group":
      content = `group ${typeof node.label === "string" && node.label ? JSON.stringify(node.label) : "(no label)"}`;
      break;
    default:
      content = String(node.type);
  }
  const color = node.color ? `, color ${asText(node.color)}` : "";
  return `[${node.id}] ${content} at ${round(node.x)},${round(node.y)} size ${round(node.width)}×${round(node.height)}${color}`;
}

function describeEdge(edge: CanvasEdge): string {
  const fromArrow = edge.fromEnd === "arrow";
  const toArrow = edge.toEnd !== "none";
  const arrow = fromArrow && toArrow ? "↔" : fromArrow ? "←" : toArrow ? "→" : "—";
  const label = typeof edge.label === "string" && edge.label ? `: ${edge.label}` : "";
  const color = edge.color ? ` (color ${asText(edge.color)})` : "";
  return `[${edge.id}] ${edge.fromNode} ${arrow} ${edge.toNode}${label}${color}`;
}

function preview(text: string): string {
  if (text.length <= TEXT_PREVIEW) return JSON.stringify(text);
  return `${JSON.stringify(text.slice(0, TEXT_PREVIEW))}… (+${text.length - TEXT_PREVIEW} chars; read_file shows all)`;
}

function round(value: unknown): number {
  return Math.round(Number(value) || 0);
}

// ─── Searching ──────────────────────────────────────────────────────────────

/** Text of cards, group labels and edge labels, for search_vault. */
export function canvasSearchTexts(data: CanvasData): { id: string; kind: string; text: string }[] {
  const texts: { id: string; kind: string; text: string }[] = [];
  for (const node of data.nodes) {
    if (node.type === "text" && typeof node.text === "string") texts.push({ id: node.id, kind: "node", text: node.text });
    if (node.type === "group" && typeof node.label === "string") texts.push({ id: node.id, kind: "group", text: node.label });
  }
  for (const edge of data.edges) {
    if (typeof edge.label === "string") texts.push({ id: edge.id, kind: "edge", text: edge.label });
  }
  return texts;
}

// ─── Editing ────────────────────────────────────────────────────────────────

/**
 * Applies the operations to `data` in place and returns one summary line per
 * operation. Throws on the first invalid operation; the caller must then
 * discard `data`.
 */
export function applyCanvasOperations(
  data: CanvasData,
  operations: unknown[],
  fileExists: (path: string) => boolean
): string[] {
  const refs = new Map<string, string>();
  const summary: string[] = [];

  const resolve = (ref: unknown): string => {
    const key = typeof ref === "string" ? ref : "";
    return refs.get(key) ?? key;
  };
  const findNode = (ref: unknown, field: string): CanvasNode => {
    const id = resolve(ref);
    const node = data.nodes.find((n) => n.id === id);
    if (!node) throw new Error(`'${field}': no node with id "${asText(ref)}"`);
    return node;
  };
  const findEdge = (ref: unknown): CanvasEdge => {
    const edge = data.edges.find((e) => e.id === ref);
    if (!edge) throw new Error(`no edge with id "${asText(ref)}"`);
    return edge;
  };
  const newId = (): string => {
    const taken = new Set([...data.nodes.map((n) => n.id), ...data.edges.map((e) => e.id)]);
    for (;;) {
      const bytes = crypto.getRandomValues(new Uint8Array(8));
      const id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
      if (!taken.has(id)) return id;
    }
  };

  operations.forEach((raw, index) => {
    // Models sometimes send null for fields they don't use.
    const op = isRecord(raw) ? Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== null)) : {};
    const name = typeof op.op === "string" ? op.op : "";
    try {
      switch (name) {
        case "add_node":
          summary.push(addNode(op));
          break;
        case "update_node":
          summary.push(updateNode(op));
          break;
        case "move_node":
          summary.push(moveNode(op));
          break;
        case "remove_node":
          summary.push(removeNode(op));
          break;
        case "add_edge":
          summary.push(addEdge(op));
          break;
        case "update_edge":
          summary.push(updateEdge(op));
          break;
        case "remove_edge":
          summary.push(removeEdge(op));
          break;
        default:
          throw new Error(`unknown op "${name}". Use add_node, update_node, move_node, remove_node, add_edge, update_edge or remove_edge.`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`Operation ${index + 1} (${name || "missing op"}): ${msg}`);
    }
  });
  return summary;

  function addNode(op: Record<string, unknown>): string {
    const type = typeof op.type === "string" ? op.type : "";
    if (!NODE_TYPES.includes(type)) throw new Error(`'type' must be one of ${NODE_TYPES.join(", ")}`);
    const content: Record<string, unknown> = {};
    if (type === "text") content.text = requireString(op, "text");
    if (type === "file") {
      content.file = requireFile(op.file);
      if (optionalText(op.subpath)) content.subpath = normalizeSubpath(op.subpath);
    }
    if (type === "link") content.url = requireString(op, "url");
    if (type === "group" && optionalText(op.label)) content.label = op.label;
    const size = defaultSize(type, typeof content.text === "string" ? content.text : "");
    const node: CanvasNode = {
      id: newId(),
      type,
      ...content,
      x: 0,
      y: 0,
      width: positiveInt(op.width, "width") ?? size.width,
      height: positiveInt(op.height, "height") ?? size.height,
    };
    if (op.color !== undefined && op.color !== "") node.color = requireColor(op.color);

    const x = optionalInt(op.x, "x");
    const y = optionalInt(op.y, "y");
    if ((x === undefined) !== (y === undefined)) throw new Error("give both 'x' and 'y', or neither");
    const target = op.group !== undefined ? findGroup(op.group) : undefined;
    const anchor = op.near !== undefined ? findNode(op.near, "near") : undefined;
    const position = x !== undefined && y !== undefined
      ? { x, y }
      : place(node, new Set(), anchor, side(op.side), target);
    node.x = position.x;
    node.y = position.y;
    const grown = growGroups(node, anchor, target);

    // Groups go below everything else (array order is z-order).
    if (type === "group") data.nodes.unshift(node);
    else data.nodes.push(node);
    if (typeof op.ref === "string" && op.ref) refs.set(op.ref, node.id);
    return `Added ${type} node ${node.id}${refNote(op)} at ${node.x},${node.y} size ${node.width}×${node.height}${grown}.`;
  }

  function updateNode(op: Record<string, unknown>): string {
    const node = findNode(op.id, "id");
    const changed: string[] = [];
    const only = (field: string, type: string) => {
      if (node.type !== type) throw new Error(`'${field}' only applies to ${type} nodes; ${node.id} is a ${node.type} node`);
    };
    if (op.text !== undefined) {
      only("text", "text");
      node.text = requireString(op, "text");
      changed.push("text");
    }
    if (op.file !== undefined) {
      only("file", "file");
      node.file = requireFile(op.file);
      changed.push("file");
    }
    if (op.subpath !== undefined) {
      only("subpath", "file");
      setOrDelete(node, "subpath", optionalText(op.subpath) ? normalizeSubpath(String(op.subpath)) : undefined);
      changed.push("subpath");
    }
    if (op.url !== undefined) {
      only("url", "link");
      node.url = requireString(op, "url");
      changed.push("url");
    }
    if (op.label !== undefined) {
      only("label", "group");
      setOrDelete(node, "label", optionalText(op.label) ? op.label : undefined);
      changed.push("label");
    }
    if (op.color !== undefined) {
      setOrDelete(node, "color", op.color === "" ? undefined : requireColor(op.color));
      changed.push("color");
    }
    const width = positiveInt(op.width, "width");
    const height = positiveInt(op.height, "height");
    if (width !== undefined) node.width = width;
    if (height !== undefined) node.height = height;
    if (width !== undefined || height !== undefined) changed.push(`size ${node.width}×${node.height}`);
    if (!changed.length) {
      throw new Error("nothing to update; give text, file, subpath, url, label, color, width or height (use move_node to move)");
    }
    return `Updated node ${node.id}: ${changed.join(", ")}.`;
  }

  function moveNode(op: Record<string, unknown>): string {
    const node = findNode(op.id, "id");
    const x = optionalInt(op.x, "x");
    const y = optionalInt(op.y, "y");
    const target = op.group !== undefined ? findGroup(op.group) : undefined;
    const anchor = op.near !== undefined ? findNode(op.near, "near") : undefined;
    if (x === undefined && y === undefined && !target && !anchor) {
      throw new Error("give 'x'/'y', 'near' (with 'side') or 'group'");
    }
    if (target === node || anchor === node) throw new Error("a node can't be placed relative to itself");
    // A group carries the nodes inside it, as when dragged in Obsidian.
    const members = node.type === "group" ? data.nodes.filter((n) => n !== node && contains(node, n)) : [];
    if ((target && members.includes(target)) || (anchor && members.includes(anchor))) {
      throw new Error("a group can't be placed relative to a node inside it");
    }
    const moving = new Set([node, ...members]);
    const position = x !== undefined || y !== undefined
      ? { x: x ?? node.x, y: y ?? node.y }
      : place(node, moving, anchor, side(op.side), target);
    const dx = position.x - node.x;
    const dy = position.y - node.y;
    for (const n of moving) {
      n.x += dx;
      n.y += dy;
    }
    const grown = growGroups(node, anchor, target);
    const carried = members.length ? ` with the ${members.length} node(s) inside it` : "";
    return `Moved node ${node.id}${carried} to ${node.x},${node.y}${grown}.`;
  }

  function removeNode(op: Record<string, unknown>): string {
    const node = findNode(op.id, "id");
    data.nodes.splice(data.nodes.indexOf(node), 1);
    const before = data.edges.length;
    data.edges = data.edges.filter((e) => e.fromNode !== node.id && e.toNode !== node.id);
    const removedEdges = before - data.edges.length;
    const edgeNote = removedEdges ? ` and its ${removedEdges} edge(s)` : "";
    const groupNote = node.type === "group" ? " (the nodes inside it were kept)" : "";
    return `Removed node ${node.id}${edgeNote}${groupNote}.`;
  }

  function addEdge(op: Record<string, unknown>): string {
    const from = findNode(op.fromNode, "fromNode");
    const to = findNode(op.toNode, "toNode");
    const sides = defaultSides(from, to);
    const edge: CanvasEdge = {
      id: newId(),
      fromNode: from.id,
      fromSide: op.fromSide !== undefined ? requireEnum(op.fromSide, "fromSide", SIDES) : sides.fromSide,
      toNode: to.id,
      toSide: op.toSide !== undefined ? requireEnum(op.toSide, "toSide", SIDES) : sides.toSide,
    };
    if (op.fromEnd !== undefined) edge.fromEnd = requireEnum(op.fromEnd, "fromEnd", ENDS);
    if (op.toEnd !== undefined) edge.toEnd = requireEnum(op.toEnd, "toEnd", ENDS);
    if (op.color !== undefined && op.color !== "") edge.color = requireColor(op.color);
    const label = optionalText(op.label) ? op.label : undefined;
    if (label) edge.label = label;
    data.edges.push(edge);
    if (typeof op.ref === "string" && op.ref) refs.set(op.ref, edge.id);
    return `Added edge ${edge.id}${refNote(op)}: ${from.id} → ${to.id}${label ? `: ${label}` : ""}.`;
  }

  function updateEdge(op: Record<string, unknown>): string {
    const edge = findEdge(resolve(op.id));
    const changed: string[] = [];
    if (op.fromNode !== undefined) {
      edge.fromNode = findNode(op.fromNode, "fromNode").id;
      changed.push("fromNode");
    }
    if (op.toNode !== undefined) {
      edge.toNode = findNode(op.toNode, "toNode").id;
      changed.push("toNode");
    }
    for (const field of ["fromSide", "toSide"]) {
      if (op[field] !== undefined) {
        edge[field] = requireEnum(op[field], field, SIDES);
        changed.push(field);
      }
    }
    for (const field of ["fromEnd", "toEnd"]) {
      if (op[field] !== undefined) {
        edge[field] = requireEnum(op[field], field, ENDS);
        changed.push(field);
      }
    }
    if (op.label !== undefined) {
      setOrDelete(edge, "label", optionalText(op.label) ? op.label : undefined);
      changed.push("label");
    }
    if (op.color !== undefined) {
      setOrDelete(edge, "color", op.color === "" ? undefined : requireColor(op.color));
      changed.push("color");
    }
    if (!changed.length) {
      throw new Error("nothing to update; give fromNode, toNode, fromSide, toSide, fromEnd, toEnd, label or color");
    }
    return `Updated edge ${edge.id}: ${changed.join(", ")}.`;
  }

  function removeEdge(op: Record<string, unknown>): string {
    const edge = findEdge(resolve(op.id));
    data.edges.splice(data.edges.indexOf(edge), 1);
    return `Removed edge ${edge.id}.`;
  }

  function findGroup(ref: unknown): CanvasNode {
    const group = findNode(ref, "group");
    if (group.type !== "group") throw new Error(`'group': ${group.id} is a ${group.type} node, not a group`);
    return group;
  }

  function requireFile(value: unknown): string {
    if (typeof value !== "string" || !value) throw new Error("'file' is required (a vault path)");
    if (!fileExists(value)) throw new Error(`'file': no file at "${value}"`);
    return value;
  }

  /**
   * Finds a free spot for `rect`: next to `anchor` on `side`, inside `target`,
   * or below everything. Nodes in `moving` don't count as obstacles; nor do
   * groups the new spot is meant to be in.
   */
  function place(
    rect: Rect,
    moving: Set<CanvasNode>,
    anchor: CanvasNode | undefined,
    where: string,
    target: CanvasNode | undefined
  ): { x: number; y: number } {
    const homes = new Set(anchor ? containingGroups(anchor, data.nodes) : []);
    if (target) {
      homes.add(target);
      for (const g of containingGroups(target, data.nodes)) homes.add(g);
    }
    const obstacles = data.nodes.filter((n) => !moving.has(n) && !homes.has(n));
    const { width, height } = rect;
    const blocker = (x: number, y: number) =>
      obstacles.find((o) => overlaps({ x, y, width, height }, o, GAP / 2));

    if (anchor) {
      let x = where === "right" ? anchor.x + anchor.width + GAP
        : where === "left" ? anchor.x - GAP - width
        : anchor.x;
      let y = where === "bottom" ? anchor.y + anchor.height + GAP
        : where === "top" ? anchor.y - GAP - height
        : anchor.y;
      // Slide past obstacles: down for left/right, right for top/bottom.
      for (let hit = blocker(x, y); hit; hit = blocker(x, y)) {
        if (where === "left" || where === "right") y = hit.y + hit.height + GAP;
        else x = hit.x + hit.width + GAP;
      }
      return { x, y };
    }

    if (target) {
      const left = target.x + GROUP_PADDING;
      const maxRight = target.x + target.width - GROUP_PADDING;
      let x = left;
      let y = target.y + GROUP_PADDING;
      // Fill rows left to right; the group grows if nothing fits inside.
      for (let hit = blocker(x, y); hit; hit = blocker(x, y)) {
        x = hit.x + hit.width + GAP;
        if (x + width > maxRight) {
          x = left;
          y += GAP;
        }
      }
      return { x, y };
    }

    const others = data.nodes.filter((n) => !moving.has(n));
    if (!others.length) return { x: 0, y: 0 };
    return {
      x: Math.min(...others.map((n) => n.x)),
      y: Math.max(...others.map((n) => n.y + n.height)) + GAP,
    };
  }

  /** Grows the target group (or the anchor's groups) and their outer groups to fit `node`. */
  function growGroups(node: CanvasNode, anchor: CanvasNode | undefined, target: CanvasNode | undefined): string {
    const chain = target
      ? [target, ...containingGroups(target, data.nodes)]
      : anchor ? containingGroups(anchor, data.nodes) : [];
    const grown: string[] = [];
    let inner: Rect = node;
    for (const group of chain) {
      if (group === node) continue;
      if (growToContain(group, inner)) grown.push(group.id);
      inner = group;
    }
    return grown.length ? `; grew group ${grown.join(", ")} to fit` : "";
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRecordList(value: unknown): value is Record<string, unknown>[] {
  return Array.isArray(value) && value.every(isRecord);
}

/** A JSON value as text: strings as they are, other values as JSON, none as "". */
function asText(value: unknown): string {
  if (value === undefined || value === null) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function overlaps(a: Rect, b: Rect, margin = 0): boolean {
  return a.x < b.x + b.width + margin && b.x < a.x + a.width + margin
    && a.y < b.y + b.height + margin && b.y < a.y + a.height + margin;
}

function contains(outer: Rect, inner: Rect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

/** Groups whose bounds contain `node`, innermost first. */
function containingGroups(node: CanvasNode, nodes: CanvasNode[]): CanvasNode[] {
  return nodes
    .filter((g) => g.type === "group" && g !== node && contains(g, node))
    .sort((a, b) => a.width * a.height - b.width * b.height);
}

function growToContain(group: Rect, inner: Rect): boolean {
  const left = Math.min(group.x, inner.x - GROUP_PADDING);
  const top = Math.min(group.y, inner.y - GROUP_PADDING);
  const right = Math.max(group.x + group.width, inner.x + inner.width + GROUP_PADDING);
  const bottom = Math.max(group.y + group.height, inner.y + inner.height + GROUP_PADDING);
  if (left === group.x && top === group.y && right === group.x + group.width && bottom === group.y + group.height) {
    return false;
  }
  Object.assign(group, { x: left, y: top, width: right - left, height: bottom - top });
  return true;
}

/** Obsidian's default card sizes; text cards are sized roughly to their text. */
function defaultSize(type: string, text: string): { width: number; height: number } {
  if (type === "text") {
    const width = text.length > 120 ? 400 : 250;
    const charsPerLine = Math.floor((width - 40) / 8);
    const lines = text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / charsPerLine)), 0);
    return { width, height: Math.max(60, Math.ceil((lines * 26 + 34) / 10) * 10) };
  }
  if (type === "group") return { width: 500, height: 400 };
  return { width: 400, height: 400 };
}

/** Connects the facing sides of two nodes. */
export function defaultSides(from: Rect, to: Rect): { fromSide: string; toSide: string } {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? { fromSide: "right", toSide: "left" } : { fromSide: "left", toSide: "right" };
  }
  return dy >= 0 ? { fromSide: "bottom", toSide: "top" } : { fromSide: "top", toSide: "bottom" };
}

function side(value: unknown): string {
  if (value === undefined) return "right";
  return requireEnum(value, "side", SIDES);
}

function requireString(op: Record<string, unknown>, field: string): string {
  const value = op[field];
  if (typeof value !== "string") throw new Error(`'${field}' must be a string`);
  return value;
}

function optionalText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function requireEnum(value: unknown, field: string, allowed: string[]): string {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(`'${field}' must be one of ${allowed.join(", ")}`);
  }
  return value;
}

function requireColor(value: unknown): string {
  const color = typeof value === "number" ? String(value) : value;
  if (typeof color !== "string" || !/^([1-6]|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{3})$/.test(color)) {
    throw new Error("'color' must be a preset \"1\"-\"6\" (red, orange, yellow, green, cyan, purple) or a hex color like \"#FF0000\"");
  }
  return color;
}

function optionalInt(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`'${field}' must be a number`);
  return Math.round(value);
}

function positiveInt(value: unknown, field: string): number | undefined {
  const n = optionalInt(value, field);
  if (n !== undefined && n <= 0) throw new Error(`'${field}' must be positive`);
  return n;
}

function normalizeSubpath(subpath: string): string {
  return subpath.startsWith("#") ? subpath : `#${subpath}`;
}

function setOrDelete(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value === undefined) delete target[key];
  else target[key] = value;
}

function refNote(op: Record<string, unknown>): string {
  return typeof op.ref === "string" && op.ref ? ` (ref "${op.ref}")` : "";
}
