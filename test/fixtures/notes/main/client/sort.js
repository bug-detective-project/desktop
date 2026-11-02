/** Notes newest first. */
export function sortNotes(notes) {
  return [...notes].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
