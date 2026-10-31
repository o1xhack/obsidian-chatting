import { App, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";

/**
 * One change a turn made to the vault, with what is needed to take it
 * back. Kept in memory only: undo lasts until Obsidian is closed.
 */
type Step =
  | { kind: "edited"; path: string; before: string; after: string }
  | { kind: "created"; path: string; after: string }
  | { kind: "renamed"; from: string; to: string; links?: { path: string; after: string }[] }
  | { kind: "deleted"; folders: string[]; files: { path: string; data: ArrayBuffer }[] }
  | { kind: "folders"; folders: string[] };

/** Conservative UTF-16/binary retention bounds, shared by all live answers. */
const MAX_LOG_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
let retainedLogs: WeakRef<ChangeLog>[] = [];
const stepBytes = (step: Step): number => step.kind === "edited" ? 2 * (step.before.length + step.after.length + step.path.length)
  : step.kind === "created" ? 2 * (step.after.length + step.path.length)
  : step.kind === "deleted" ? step.files.reduce((sum, file) => sum + file.data.byteLength + 2 * file.path.length, 0) + 2 * step.folders.join("").length
  : step.kind === "renamed" ? 2 * (step.from.length + step.to.length + (step.links ?? []).reduce((sum, link) => sum + link.path.length + link.after.length, 0))
  : 2 * step.folders.join("").length;

/** What a file is expected to be after the turn: its text, there (not text), or gone. */
type Expected = { text: string } | "exists" | "absent";

/**
 * The vault changes of one answer (turn), in order, so the user can undo
 * them: edits get their text back, created files and folders go to the
 * trash, renames are renamed back (links follow) and deleted files are
 * created again.
 */
export class ChangeLog {
  private steps: Step[] = [];
  private keptFiles: string[] | null = null;
  private snapshotBytes = 0;
  private keptReason: "memory" | "restored" | "changed" | "unverified" = "memory";

  /** A continued answer whose earlier snapshots expired stays wholly kept. */
  constructor(keptFiles?: string[]) {
    if (keptFiles !== undefined) {
      this.keptFiles = [...keptFiles];
      this.keptReason = "restored";
    }
  }

  /** A budget-evicted answer keeps its changed-file row, never a partial undo. */
  canUndo(): boolean { return this.keptFiles === null; }

  unavailableReason(): string {
    return this.keptReason === "changed" ? "Intervening file changes made this answer's undo snapshots unsafe."
      : this.keptReason === "restored" ? "Earlier undo snapshots are unavailable after restarting Obsidian."
      : this.keptReason === "unverified" ? "The rename's link updates could not be verified for undo."
      : "Undo snapshots expired because their memory budget was exceeded.";
  }

  private evict(reason: "memory" | "changed" | "unverified" = "memory"): void {
    this.keptFiles = this.files();
    this.keptReason = reason;
    this.steps = [];
    this.snapshotBytes = 0;
  }

  private record(step: Step): void {
    if (this.keptFiles === null && this.steps.length) {
      const expected = this.expectedAfterSteps();
      // A later edit/deletion must not hide manual changes between this
      // answer's snapshots. Keep the entire answer rather than undoing
      // through that discontinuity and silently discarding the user's work.
      const prior = "path" in step ? expected.get(step.path) : undefined;
      const changed = step.kind === "edited" ? prior === "absent" || (typeof prior === "object" && prior.text !== step.before)
        : step.kind === "created" ? expected.has(step.path) && prior !== "absent"
        : step.kind === "renamed" ? expected.get(step.from) === "absent"
        : step.kind === "deleted" && step.files.some(file => {
          const prior = expected.get(file.path);
          return prior === "absent" || (typeof prior === "object" && prior.text !== new TextDecoder().decode(file.data));
        });
      if (changed) this.evict("changed");
    }
    if (this.keptFiles !== null) {
      const names = this.keptFiles;
      if (step.kind === "renamed") {
        const at = names.indexOf(step.from);
        if (at >= 0) names[at] = step.to;
        else if (!names.includes(step.to)) names.push(step.to);
      } else {
        const paths = step.kind === "deleted" ? step.files.map(file => file.path)
          : step.kind === "folders" ? [] : [step.path];
        for (const path of paths) if (!names.includes(path)) names.push(path);
      }
      return;
    }
    const last = this.steps.at(-1);
    // Only adjacent edits with matching boundaries can be coalesced safely.
    if (step.kind === "edited" && (last?.kind === "edited" || last?.kind === "created") && last.path === step.path && last.after === step.before) {
      this.snapshotBytes -= stepBytes(last);
      last.after = step.after;
      this.snapshotBytes += stepBytes(last);
    } else {
      this.steps.push(step);
      this.snapshotBytes += stepBytes(step);
    }
    if (this.snapshotBytes > MAX_LOG_BYTES) this.evict();
    if (!retainedLogs.some(ref => ref.deref() === this)) retainedLogs.push(new WeakRef(this));
    const live = retainedLogs.flatMap(ref => { const log = ref.deref(); return log && log.canUndo() && !log.isEmpty() ? [log] : []; });
    let total = live.reduce((sum, log) => sum + log.snapshotBytes, 0);
    for (const log of live) {
      if (total <= MAX_TOTAL_BYTES) break;
      total -= log.snapshotBytes;
      log.evict();
    }
    // Weak references do not extend a conversation's undo lifetime.
    retainedLogs = live.filter(log => log.canUndo()).map(log => new WeakRef(log));
  }

  /** The tools record after a successful change. */
  edited(path: string, before: string, after: string): void {
    if (before !== after) this.record({ kind: "edited", path, before, after });
  }

  created(path: string, after: string): void {
    this.record({ kind: "created", path, after });
  }

  /** Folders a tool created for a file, outermost first. */
  foldersCreated(folders: string[]): void {
    if (folders.length) this.record({ kind: "folders", folders });
  }

  renamed(from: string, to: string): void {
    this.record({ kind: "renamed", from, to });
  }

  /** Capture rename-owned link rewrites only for notes already in this log. */
  async renaming(app: App, from: string, to: string): Promise<() => Promise<void>> {
    const tracked: { path: string; before: string }[] = [];
    if (this.canUndo()) for (const [path, state] of this.expectedAfterSteps()) {
      if (typeof state !== "object") continue;
      const file = app.vault.getFileByPath(path);
      const before = file ? await app.vault.cachedRead(file) : undefined;
      if (before !== state.text) {
        this.evict("changed");
        break;
      }
      tracked.push({ path, before });
    }
    return async () => {
      const links: { path: string; after: string }[] = [];
      if (this.canUndo()) try {
        for (const prior of tracked) {
          const path = prior.path === from || prior.path.startsWith(`${from}/`) ? to + prior.path.slice(from.length) : prior.path;
          const file = app.vault.getFileByPath(path);
          if (!file) throw new Error("Tracked note missing after rename");
          const after = await app.vault.cachedRead(file);
          if (after !== prior.before) links.push({ path, after });
        }
      } catch {
        this.evict("unverified");
      }
      this.record({ kind: "renamed", from, to, ...(links.length ? { links } : {}) });
    };
  }

  /** Before deleting `target`: keeps its files (a folder's too) to create them again. */
  async deleting(app: App, target: TAbstractFile): Promise<() => void> {
    const folders: string[] = [];
    let bytes = 0;
    const maxBytes = 32 * 1024 * 1024;
    const files: { path: string; data: ArrayBuffer }[] = [];
    const visit = async (item: TAbstractFile): Promise<void> => {
      if (item instanceof TFile) {
        if (files.length >= 1000 || bytes + (item.stat?.size ?? 0) > maxBytes) throw new Error("The deletion exceeds the undo snapshot limit (1000 files / 32 MiB); no files were deleted.");
        const data = await app.vault.readBinary(item);
        bytes += data.byteLength;
        if (bytes > maxBytes) throw new Error("The deletion exceeds the undo snapshot limit (32 MiB); no files were deleted.");
        files.push({ path: item.path, data });
      } else if (item instanceof TFolder) {
        folders.push(item.path);
        for (const child of item.children) await visit(child);
      }
    };
    await visit(target);
    return () => this.record({ kind: "deleted", folders, files });
  }

  isEmpty(): boolean {
    return this.steps.length === 0 && !this.keptFiles?.length;
  }

  /** The files the turn changed, named as it left them (deleted ones as they were). */
  files(): string[] {
    if (this.keptFiles !== null) return [...this.keptFiles];
    const names: string[] = [];
    const add = (path: string) => {
      if (!names.includes(path)) names.push(path);
    };
    for (const step of this.steps) {
      if (step.kind === "renamed") {
        const at = names.indexOf(step.from);
        if (at === -1) add(step.to);
        else names[at] = step.to;
      } else if (step.kind === "deleted") {
        step.files.forEach((file) => add(file.path));
      } else if (step.kind !== "folders") {
        add(step.path);
      }
    }
    return names;
  }

  /** The expected vault state after the recorded changes, including renames. */
  private expectedAfterSteps(): Map<string, Expected> {
    const expected = new Map<string, Expected>();
    for (const step of this.steps) {
      if (step.kind === "edited" || step.kind === "created") {
        expected.set(step.path, { text: step.after });
      } else if (step.kind === "renamed") {
        const descendants = [...expected].filter(([path]) => path.startsWith(`${step.from}/`));
        for (const [path, state] of descendants) {
          expected.set(step.to + path.slice(step.from.length), state);
          expected.set(path, "absent");
        }
        expected.set(step.to, expected.get(step.from) ?? "exists");
        expected.set(step.from, "absent");
        for (const link of step.links ?? []) expected.set(link.path, { text: link.after });
      } else if (step.kind === "deleted") {
        for (const file of step.files) expected.set(file.path, "absent");
        for (const folder of step.folders) expected.set(folder, "absent");
      } else if (step.kind === "folders") {
        for (const folder of step.folders) expected.set(folder, "exists");
      }
    }
    return expected;
  }

  /** Files changed since this answer; undo requires confirmation for these. */
  async conflicts(app: App): Promise<string[]> {
    const expected = this.expectedAfterSteps();
    const changed: string[] = [];
    for (const [path, want] of expected) {
      const item = app.vault.getAbstractFileByPath(normalizePath(path));
      const file = app.vault.getFileByPath(normalizePath(path));
      const same = want === "absent" ? !item
        : want === "exists" ? !!item
        : !!file && await app.vault.cachedRead(file) === want.text;
      if (!same) changed.push(path);
    }
    return changed;
  }

  /** Takes the changes back, last first. Returns what couldn't be undone. */
  async undo(app: App): Promise<string[]> {
    if (!this.canUndo()) return [`${this.unavailableReason()} No files were changed.`];
    const failed: string[] = [];
    while (this.steps.length) {
      const step = this.steps[this.steps.length - 1];
      try {
        await undoStep(app, step);
        this.steps.pop();
        this.snapshotBytes -= stepBytes(step);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failed.push(`${describe(step)}: ${msg}`);
        break;
      }
    }
    return failed;
  }
}

async function undoStep(app: App, step: Step): Promise<void> {
  const vault = app.vault;
  switch (step.kind) {
    case "edited": {
      const file = vault.getFileByPath(step.path);
      if (file) await vault.modify(file, step.before);
      else await createWithFolders(app, step.path, step.before);
      return;
    }
    case "created": {
      const file = vault.getFileByPath(step.path);
      if (file) await app.fileManager.trashFile(file);
      return;
    }
    case "folders": {
      // Removed again when nothing else is in them, innermost first.
      for (const path of [...step.folders].reverse()) {
        const folder = vault.getFolderByPath(path);
        if (folder && folder.children.length === 0) await app.fileManager.trashFile(folder);
      }
      return;
    }
    case "renamed": {
      const item = vault.getAbstractFileByPath(step.to);
      if (!item) throw new Error("not found");
      await ensureFolder(app, parentOf(step.from));
      // Links in other notes follow, as they did for the rename.
      await app.fileManager.renameFile(item, step.from);
      return;
    }
    case "deleted": {
      for (const folder of step.folders) await ensureFolder(app, folder);
      for (const file of step.files) {
        const existing = vault.getFileByPath(file.path);
        if (existing) {
          await vault.modifyBinary(existing, file.data);
        } else {
          if (vault.getAbstractFileByPath(file.path)) throw new Error(`${file.path} is now a folder`);
          await ensureFolder(app, parentOf(file.path));
          await vault.createBinary(file.path, file.data);
        }
      }
      return;
    }
  }
}

function describe(step: Step): string {
  if (step.kind === "renamed") return step.to;
  if (step.kind === "deleted") return step.files[0]?.path ?? step.folders[0] ?? "";
  if (step.kind === "folders") return step.folders[0] ?? "";
  return step.path;
}

function parentOf(path: string): string {
  return path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
}

async function ensureFolder(app: App, path: string): Promise<void> {
  if (!path || app.vault.getFolderByPath(path)) return;
  await ensureFolder(app, parentOf(path));
  await app.vault.createFolder(path);
}

async function createWithFolders(app: App, path: string, text: string): Promise<void> {
  await ensureFolder(app, parentOf(path));
  await app.vault.create(path, text);
}
