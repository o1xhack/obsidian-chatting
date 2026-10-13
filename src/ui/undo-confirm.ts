import { App, Modal, Setting } from "obsidian";

/**
 * Asks before undoing an answer whose files changed since (by the user or
 * a later answer): undoing would lose those changes. Resolves true to undo.
 */
export function confirmUndo(app: App, changed: string[]): Promise<boolean> {
  return new Promise((resolve) => new UndoConfirmModal(app, changed, resolve).open());
}

export class UndoConfirmModal extends Modal {
  private undo = false;

  constructor(app: App, readonly changed: string[], private readonly onDecided: (undo: boolean) => void) {
    super(app);
  }

  /** Close with the answer (the buttons; tests). */
  decide(undo: boolean): void {
    this.undo = undo;
    this.close();
  }

  onOpen(): void {
    const { contentEl } = this;
    new Setting(contentEl).setName("Undo these changes?").setHeading();
    contentEl.createEl("p", { text: "These files changed after the answer. Undoing puts them back as they were before it, so the later changes are lost:" });
    const list = contentEl.createEl("ul");
    for (const path of this.changed) list.createEl("li", { text: path });
    new Setting(contentEl)
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.decide(false)))
      .addButton((button) => {
        button.setButtonText("Undo anyway").onClick(() => this.decide(true));
        // Red as a destructive button (setDestructive() needs Obsidian 1.13).
        button.buttonEl.addClass("mod-warning");
      });
  }

  onClose(): void {
    this.contentEl.empty();
    this.onDecided(this.undo);
  }
}
