/** The notes whose title or text contains the query, ignoring case. */
export function search(notes, query) {
  const needle = query.toLowerCase();
  return notes.filter((note) => `${note.title} ${note.text}`.toLowerCase().includes(needle));
}
