/**
 * Capacitor (Obsidian's mobile apps) fires `resume` on the document when
 * the app returns to the foreground (`pause` is already in the DOM types).
 */
interface DocumentEventMap {
  resume: Event;
}
