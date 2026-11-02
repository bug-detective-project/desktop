/** The title shown for a note: its own, trimmed, or "Untitled". */
export function titleOf(note) {
  const title = (note.title ?? '').trim();
  return title === '' ? 'Untitled' : title;
}
