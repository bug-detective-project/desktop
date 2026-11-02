/** The first line of a note's text, cut at 40 characters with an ellipsis. */
export function previewOf(note) {
  const line = (note.text ?? '').split('\n')[0];
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}
