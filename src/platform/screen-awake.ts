/**
 * Keeps the screen on while an answer is generated, so a phone doesn't go
 * to sleep in the middle (the web's Screen Wake Lock API, no Obsidian
 * internals). Each user holds it with `hold()` and lets go with the
 * function that returns; the lock lasts while anyone holds it. The system
 * drops the lock when the app goes to the background, so it is asked for
 * again when the app is back. No single event says so reliably, so it
 * listens to several: the page's `visibilitychange`, Capacitor's `resume`
 * (Obsidian's mobile apps) and the window's `focus` and `pageshow`. Where
 * the API is missing, nothing happens.
 */
class ScreenAwake {
  private holders = 0;
  /** Counts resets: a hold from before the last reset lets go of nothing. */
  private generation = 0;
  private lock: WakeLockSentinel | null = null;
  private requesting = false;
  private watching = false;
  private readonly onBack = (): void => void this.sync();

  /** Keep the screen on until the returned function is called (once is enough). */
  hold(): () => void {
    this.holders++;
    this.watch(true);
    void this.sync();
    const generation = this.generation;
    let released = false;
    return () => {
      if (released || generation !== this.generation) return;
      released = true;
      this.holders--;
      if (this.holders === 0) this.watch(false);
      void this.sync();
    };
  }

  /** Let go of everything (the plugin unloads). */
  reset(): void {
    this.generation++;
    this.holders = 0;
    this.watch(false);
    void this.release();
  }

  /** Listen (or stop listening) for the app being back. */
  private watch(on: boolean): void {
    if (on === this.watching || typeof document === "undefined") return;
    this.watching = on;
    const targets: Array<[EventTarget, string]> = [[document, "visibilitychange"], [document, "resume"]];
    if (typeof window !== "undefined") targets.push([window, "focus"], [window, "pageshow"]);
    for (const [target, type] of targets) {
      if (on) target.addEventListener(type, this.onBack);
      else target.removeEventListener(type, this.onBack);
    }
  }

  private async sync(): Promise<void> {
    if (this.holders === 0) {
      await this.release();
      return;
    }
    if ((this.lock && !this.lock.released) || this.requesting) return;
    if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    if (typeof document === "undefined" || document.visibilityState !== "visible") return;
    this.requesting = true;
    try {
      this.lock = await navigator.wakeLock.request("screen");
    } catch {
      // Refused (e.g. battery saver) or not allowed here: the screen sleeps as usual.
      this.lock = null;
    } finally {
      this.requesting = false;
    }
    // Everyone let go while it was being requested.
    if (this.holders === 0) await this.release();
  }

  private async release(): Promise<void> {
    const lock = this.lock;
    this.lock = null;
    if (lock && !lock.released) await lock.release().catch(() => undefined);
  }
}

/** The one instance for the plugin. */
export const screenAwake = new ScreenAwake();
