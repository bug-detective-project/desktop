/** The first line of a note's text, cut at 40 characters with an ellipsis. */
export function previewOf(note) {
  return (note.text ?? '').split('\n')[0];
}
