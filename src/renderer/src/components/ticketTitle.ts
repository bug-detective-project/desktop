import type { Snapshot } from '@shared/api.ts';
import type { Language } from '@shared/types.ts';

/** Splits "SD-214: Ticket details don't change…" into its key and its text. */
export function ticketTitle(snapshot: Snapshot, ticket: number, language: Language): { key: string; text: string } {
  const title = snapshot.titles[ticket]?.[language] ?? `Ticket ${ticket}`;
  const [key, ...rest] = title.split(': ');
  return rest.length > 0 ? { key, text: rest.join(': ') } : { key: `#${ticket}`, text: title };
}
