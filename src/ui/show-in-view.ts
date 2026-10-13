/**
 * Shows a spot in a note or canvas in the main area: the text range is
 * scrolled to and highlighted, canvas cards are selected and centered. It
 * uses Obsidian's own search-result navigation (the `match` ephemeral
 * state), so both edit and reading view behave natively (reading view
 * scrolls and flashes the line). On a canvas, all changed cards are then
 * selected and centered, zooming out only when they don't fit; that uses
 * the canvas view's internal API, guarded, so without it the match state's
 * select-and-pan stays.
 *
 * The view opens where the note already is, else in one reused tab, so the
 * user's own tab never changes under them. The follow tab is closed when
 * the plugin unloads (also when Obsidian closes) or, if it was saved with
 * the layout, at the next start (`closeFollowTab`). Used for following the
 * AI's edits (`followEdits`) and by `open_document`.
 */
import { Platform, type App, type FileView, type TextFileView, type TFile, type WorkspaceLeaf } from "obsidian";
import type { ViewTarget } from "../types";

/** The tab the AI's edits are shown in, reused while it is open. */
let followLeaf: WorkspaceLeaf | null = null;
/** Per vault (`saveLocalStorage`): the follow tab's ID, to close it at the next start. */
const FOLLOW_TAB_KEY = "chatting-with-ai-follow-tab";

/**
 * Open `target` in the main area. `reveal`: bring it to the front even on a
 * phone, where that closes the chat (only when the user asked for it).
 * False when the file doesn't exist.
 */
export async function showInView(app: App, target: ViewTarget, { reveal = false } = {}): Promise<boolean> {
  const file = app.vault.getFileByPath(target.path);
  if (!file) return false;
  // Only our own tab becomes the follow tab: one the user has the note open
  // in is shown, never taken over for the next note.
  const shown = leafShowing(app, file);
  const leaf = shown ?? reusableLeaf(app);
  if (!shown) rememberFollowTab(app, leaf);
  const eState = await matchState(app, file, target);
  if ((leaf.view as FileView | undefined)?.file?.path === file.path) {
    // An open note takes in the change a moment after the file is written,
    // which would drop a highlight set before: wait for the new text.
    if (eState) {
      await showsText(leaf, eState);
      leaf.setEphemeralState(eState);
    }
  } else {
    await leaf.openFile(file, { active: false, ...(eState ? { eState } : {}) });
  }
  // On a phone the chat covers the note: bringing it forward would close
  // the chat, so following leaves it behind (the user sees it on closing).
  if (reveal || !Platform.isMobile) await app.workspace.revealLeaf(leaf);
  if (file.extension === "canvas" && target.nodes?.length) await centerCards(leaf, target.nodes);
  return true;
}

/**
 * Close the follow tab (the plugin unloads, e.g. Obsidian closes). Its ID
 * stays saved: if Obsidian saved the layout before, the tab comes back at
 * the next start and `closeLeftoverFollowTab` closes it then.
 */
export function closeFollowTab(app: App): void {
  const leaf = followLeaf;
  followLeaf = null;
  if (leaf && isOpenInMain(app, leaf)) leaf.detach();
}

/** At start: close a follow tab the last session's layout brought back. */
export function closeLeftoverFollowTab(app: App): void {
  const saved = app.loadLocalStorage?.(FOLLOW_TAB_KEY) as unknown;
  app.saveLocalStorage?.(FOLLOW_TAB_KEY, null);
  const leaf = typeof saved === "string" ? app.workspace.getLeafById?.(saved) : null;
  if (leaf && leaf !== followLeaf && isOpenInMain(app, leaf)) leaf.detach();
}

function rememberFollowTab(app: App, leaf: WorkspaceLeaf): void {
  followLeaf = leaf;
  // The ID isn't in Obsidian's types; getLeafById() looks leaves up by it.
  const id = (leaf as unknown as { id?: unknown }).id;
  if (typeof id === "string") app.saveLocalStorage?.(FOLLOW_TAB_KEY, id);
}

function isOpenInMain(app: App, leaf: WorkspaceLeaf): boolean {
  let open = false;
  app.workspace.iterateRootLeaves((each) => {
    if (each === leaf) open = true;
  });
  return open;
}

/** Resolves once the note in `leaf` shows the match's text (at most about 1 s). */
async function showsText(leaf: WorkspaceLeaf, eState: Record<string, unknown>): Promise<void> {
  const match = eState.match as { content?: string } | undefined;
  const view = leaf.view as Partial<TextFileView> | undefined;
  if (!match?.content || typeof view?.getViewData !== "function") return;
  for (let i = 0; i < 20 && view.getViewData() !== match.content; i++) {
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
}

interface BBox { minX: number; minY: number; maxX: number; maxY: number }
interface CanvasCard { getBBox(): BBox }
/** The parts of Obsidian's canvas view used here (internal, so all checked). */
interface CanvasApi {
  nodes: Map<string, CanvasCard>;
  selection: Set<CanvasCard>;
  updateSelection(change: () => void): void;
  canvasRect: { width: number; height: number };
  tx: number;
  ty: number;
  /** Target zoom, log2 (0 = 100 %). */
  tZoom: number;
  zoomCenter: unknown;
  markViewportChanged(): void;
}

function canvasOf(leaf: WorkspaceLeaf): CanvasApi | null {
  const canvas = (leaf.view as { canvas?: Partial<CanvasApi> } | undefined)?.canvas;
  const ok = canvas && canvas.nodes instanceof Map && canvas.selection instanceof Set &&
    typeof canvas.updateSelection === "function" && typeof canvas.markViewportChanged === "function" &&
    typeof canvas.tZoom === "number" && typeof canvas.canvasRect?.width === "number";
  return ok ? (canvas as CanvasApi) : null;
}

/**
 * Select the cards and center them; zoom out (never in) only when they
 * don't fit. Waits up to about 1 s for the cards (an open canvas takes in
 * the change a moment after the file is written).
 */
async function centerCards(leaf: WorkspaceLeaf, ids: string[]): Promise<void> {
  let cards: CanvasCard[] = [];
  for (let i = 0; i < 20; i++) {
    const canvas = canvasOf(leaf);
    cards = canvas ? ids.map((id) => canvas.nodes.get(id)).filter((card): card is CanvasCard => !!card) : [];
    if (cards.length === ids.length) break;
    await new Promise((resolve) => window.setTimeout(resolve, 50));
  }
  const canvas = canvasOf(leaf);
  if (!canvas || !cards.length) return;
  canvas.updateSelection(() => {
    canvas.selection.clear();
    for (const card of cards) canvas.selection.add(card);
  });
  const view = canvas.canvasRect;
  const box = unionBox(cards.map((card) => card.getBBox()));
  const target = viewportFor(box, view.width, view.height, canvas.tZoom);
  canvas.tx = target.x;
  canvas.ty = target.y;
  canvas.tZoom = target.zoom;
  canvas.zoomCenter = null;
  canvas.markViewportChanged();
}

function unionBox(boxes: BBox[]): BBox {
  return {
    minX: Math.min(...boxes.map((b) => b.minX)),
    minY: Math.min(...boxes.map((b) => b.minY)),
    maxX: Math.max(...boxes.map((b) => b.maxX)),
    maxY: Math.max(...boxes.map((b) => b.maxY)),
  };
}

/**
 * Where the canvas should look to center `box`: its middle, and the zoom
 * (log2) at which it fits with a 10 % margin, if that is smaller than the
 * current one; otherwise the zoom stays.
 */
export function viewportFor(box: BBox, width: number, height: number, zoom: number): { x: number; y: number; zoom: number } {
  const x = (box.minX + box.maxX) / 2;
  const y = (box.minY + box.maxY) / 2;
  const w = Math.max(1, box.maxX - box.minX);
  const h = Math.max(1, box.maxY - box.minY);
  const fits = Math.log2(Math.min(width / (1.1 * w), height / (1.1 * h)));
  return { x, y, zoom: Math.min(zoom, fits) };
}

/** A main-area tab that already shows the file. */
function leafShowing(app: App, file: TFile): WorkspaceLeaf | null {
  let found: WorkspaceLeaf | null = null;
  app.workspace.iterateRootLeaves((leaf) => {
    if (!found && (leaf.view as FileView | undefined)?.file?.path === file.path) found = leaf;
  });
  return found;
}

/** The follow tab if it is still open in the main area, else a new tab. */
function reusableLeaf(app: App): WorkspaceLeaf {
  return followLeaf && isOpenInMain(app, followLeaf) ? followLeaf : app.workspace.getLeaf("tab");
}

/** Obsidian's search-result state for the spot; undefined when there is none. */
async function matchState(app: App, file: TFile, target: ViewTarget): Promise<Record<string, unknown> | undefined> {
  if (file.extension === "canvas") {
    const node = target.nodes?.[0];
    return node ? { match: { nodeId: node, content: "", matches: [] } } : undefined;
  }
  if (target.from === undefined) return undefined;
  const content = await app.vault.cachedRead(file);
  const [from, to] = visibleRange(content, target.from, target.to ?? target.from);
  return { match: { content, matches: [[from, to]] } };
}

/** The range, or for an empty one (a deletion) the line it is on. */
export function visibleRange(content: string, from: number, to: number): [number, number] {
  const start = Math.max(0, Math.min(from, content.length));
  const end = Math.max(start, Math.min(to, content.length));
  if (end > start) return [start, end];
  const lineStart = content.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = content.indexOf("\n", start);
  return [lineStart, lineEnd === -1 ? content.length : lineEnd];
}

/**
 * The part of a text that changed, as a range in the new text: the text
 * between the unchanged start and end. Null when nothing changed.
 */
export function changedRange(before: string, after: string): { from: number; to: number } | null {
  if (before === after) return null;
  let start = 0;
  const max = Math.min(before.length, after.length);
  while (start < max && before[start] === after[start]) start++;
  let end = 0;
  while (end < max - start && before[before.length - 1 - end] === after[after.length - 1 - end]) end++;
  return { from: start, to: after.length - end };
}
