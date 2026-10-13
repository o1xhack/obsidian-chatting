import { App, TAbstractFile, TFile, TFolder, normalizePath } from "obsidian";

/**
 * One change a turn made to the vault, with what is needed to take it
 * back. Kept in memory only: undo lasts until Obsidian is closed.
 */
type Step =
  | { kind: "edited"; path: string; before: string; after: string }
  | { kind: "created"; path: string; after: string }
  | { kind: "renamed"; from: string; to: string }
  | { kind: "deleted"; folders: string[]; files: { path: string; data: ArrayBuffer }[] }
  | { kind: "folders"; folders: string[] };

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

  /** The tools record after a successful change. */
  edited(path: string, before: string, after: string): void {
    if (before !== after) this.steps.push({ kind: "edited", path, before, after });
  }

  created(path: string, after: string): void {
    this.steps.push({ kind: "created", path, after });
  }

  /** Folders a tool created for a file, outermost first. */
  foldersCreated(folders: string[]): void {
    if (folders.length) this.steps.push({ kind: "folders", folders });
  }

  renamed(from: string, to: string): void {
    this.steps.push({ kind: "renamed", from, to });
  }

  /** Before deleting `target`: keeps its files (a folder's too) to create them again. */
  async deleting(app: App, target: TAbstractFile): Promise<void> {
    const folders: string[] = [];
    const files: { path: string; data: ArrayBuffer }[] = [];
    const visit = async (item: TAbstractFile): Promise<void> => {
      if (item instanceof TFile) {
        files.push({ path: item.path, data: await app.vault.readBinary(item) });
      } else if (item instanceof TFolder) {
        folders.push(item.path);
        for (const child of item.children) await visit(child);
      }
    };
    await visit(target);
    this.steps.push({ kind: "deleted", folders, files });
  }

  isEmpty(): boolean {
    return this.steps.length === 0;
  }

  /** The files the turn changed, named as it left them (deleted ones as they were). */
  files(): string[] {
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

  /**
   * Files that changed after the turn (by the user or a later answer):
   * undoing would lose those changes.
   */
  async conflicts(app: App): Promise<string[]> {
    const expected = new Map<string, Expected>();
    for (const step of this.steps) {
      if (step.kind === "edited" || step.kind === "created") {
        expected.set(step.path, { text: step.after });
      } else if (step.kind === "renamed") {
        expected.set(step.to, expected.get(step.from) ?? "exists");
        expected.set(step.from, "absent");
      } else if (step.kind === "deleted") {
        for (const file of step.files) expected.set(file.path, "absent");
      }
    }
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
    const failed: string[] = [];
    for (const step of [...this.steps].reverse()) {
      try {
        await undoStep(app, step);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        failed.push(`${describe(step)}: ${msg}`);
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
        if (vault.getAbstractFileByPath(file.path)) continue;
        await ensureFolder(app, parentOf(file.path));
        await vault.createBinary(file.path, file.data);
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
