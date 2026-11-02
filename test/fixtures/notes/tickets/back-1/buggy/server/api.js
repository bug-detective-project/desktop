/** The notes whose title or text contains the query, ignoring case. */
export function search(notes, query) {
  return notes.filter((note) => `${note.title} ${note.text}`.includes(query));
}
