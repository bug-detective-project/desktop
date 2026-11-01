/** What unlockTicket records about a ticket, for tests that do not care about the manifest. */
export function unlocked(ticket: number, commit: string | null = 'x', counts = { front: 4, back: 0 }, id = `front-${ticket}`) {
  return { id, track: id.split('-')[0] as 'front' | 'back', commit, manifestVersion: '1.0.0', counts };
}
