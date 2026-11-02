/** The title shown for a note: its own, trimmed, or "Untitled". */
export function titleOf(note) {
  return (note.title ?? '').trim();
}
