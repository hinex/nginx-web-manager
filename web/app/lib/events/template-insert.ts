/**
 * Simple event bus for communicating template insertions
 * between the Templates page and the Config Editor.
 *
 * Includes a pending buffer so that emitting an insert when no
 * listener is subscribed (e.g. cross-route navigation) will
 * replay the text once a listener subscribes.
 */

type Listener = (text: string) => void;
const listeners = new Set<Listener>();
let pendingInsert: string | null = null;

export function emitTemplateInsert(text: string) {
  if (listeners.size > 0) {
    for (const fn of listeners) fn(text);
  } else {
    pendingInsert = text;
  }
}

export function onTemplateInsert(callback: Listener): () => void {
  listeners.add(callback);
  // Replay pending insert if available
  if (pendingInsert !== null) {
    const text = pendingInsert;
    pendingInsert = null;
    callback(text);
  }
  return () => { listeners.delete(callback); };
}
