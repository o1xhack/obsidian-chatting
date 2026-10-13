/**
 * Whether Obsidian is in the foreground. Obsidian has no lifecycle event,
 * so this follows hints: the document's `visibilitychange`, Capacitor's
 * `pause` and `resume` on the document (mobile apps; `pause` may come too
 * late to run anything), and the window's `focus` and `pageshow`. None is
 * reliable alone; the time the app went to the background is recorded,
 * and what to do is decided when it is back.
 */
import type { Component } from "obsidian";

export class AppLifecycle {
  private hidden = false;
  /** When the app last went to the background (never: -Infinity). */
  private hiddenAt = -Infinity;
  private readonly visibleListeners = new Set<(hiddenMs: number) => void>();
  private readonly hiddenListeners = new Set<() => void>();

  /**
   * Listen to the hints; `owner` (the plugin) removes the listeners on
   * unload. `log` gets each hint as it comes (which ones a device sends is
   * still to be checked).
   */
  watch(owner: Pick<Component, "registerDomEvent">, log: (hint: string, visibility: string) => void = () => {},
    doc: Document = document, win: Window = window): void {
    const hint = (type: string, apply: () => void) => () => {
      log(type, doc.visibilityState);
      apply();
    };
    owner.registerDomEvent(doc, "visibilitychange", hint("visibilitychange", () => {
      if (doc.visibilityState === "hidden") this.markHidden();
      else this.markVisible();
    }));
    owner.registerDomEvent(doc, "pause", hint("pause", () => this.markHidden()));
    // Capacitor says the app is active again, even if the page doesn't yet.
    owner.registerDomEvent(doc, "resume", hint("resume", () => this.markVisible()));
    const shown = () => {
      if (doc.visibilityState !== "hidden") this.markVisible();
    };
    owner.registerDomEvent(win, "focus", hint("focus", shown));
    owner.registerDomEvent(win, "pageshow", hint("pageshow", shown));
  }

  isHidden(): boolean {
    return this.hidden;
  }

  /** The app was in the background at some time since `time` (ms), or is now. */
  hiddenSince(time: number): boolean {
    return this.hidden || this.hiddenAt >= time;
  }

  /** Resolves when the app is in the foreground (at once if it is). */
  whenVisible(): Promise<void> {
    if (!this.hidden) return Promise.resolve();
    return new Promise((resolve) => {
      const off = this.onVisible(() => {
        off();
        resolve();
      });
    });
  }

  /** Call `listener` each time the app comes back, with how long it was away; returns the unsubscribe. */
  onVisible(listener: (hiddenMs: number) => void): () => void {
    this.visibleListeners.add(listener);
    return () => this.visibleListeners.delete(listener);
  }

  /** Call `listener` each time the app goes to the background; returns the unsubscribe. */
  onHidden(listener: () => void): () => void {
    this.hiddenListeners.add(listener);
    return () => this.hiddenListeners.delete(listener);
  }

  /** A hint that the app went to the background; repeated hints count once. */
  markHidden(): void {
    if (this.hidden) return;
    this.hidden = true;
    this.hiddenAt = Date.now();
    for (const listener of [...this.hiddenListeners]) listener();
  }

  /** A hint that the app is in the foreground; repeated hints count once. */
  markVisible(): void {
    if (!this.hidden) return;
    this.hidden = false;
    const hiddenMs = Date.now() - this.hiddenAt;
    for (const listener of [...this.visibleListeners]) listener(hiddenMs);
  }
}

/** The one instance; `main.ts` starts it watching. */
export const appLifecycle = new AppLifecycle();
