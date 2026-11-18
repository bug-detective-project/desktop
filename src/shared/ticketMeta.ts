/**
 * What a ticket says about itself in the project manifest (tickets/<id>/ticket.json): the kind of
 * work, and whether it touches the front end and the back end. A ticket without it is a fix ticket.
 */
import type { TicketType as ContractTicketType } from '@bug-detective/catalog/contract';

/**
 * The same list as the contract's TICKET_TYPES. Repeated here because this module also runs in the
 * renderer, which must not bundle the contract's code; the type below fails to compile if they differ.
 */
export const TICKET_TYPES = ['fix', 'build', 'complete', 'refactor', 'optimize', 'upgrade', 'investigate'] as const;
export type TicketType = (typeof TICKET_TYPES)[number];

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const TICKET_TYPES_MATCH_THE_CONTRACT: Same<TicketType, ContractTicketType> = true;

export interface TicketMetaView {
  type: TicketType;
  /** The ticket needs changes in the front end and in the back end; it still belongs to one track. */
  bothSides: boolean;
}

export function metaOfEntry(entry: { type?: TicketType; bothSides?: boolean } | undefined): TicketMetaView {
  return { type: entry?.type ?? 'fix', bothSides: entry?.bothSides ?? false };
}

/** Ticket types that share their QA and review texts. */
const TEXT_GROUP: Record<TicketType, 'fix' | 'build' | 'refactor' | 'optimize' | 'upgrade'> = {
  fix: 'fix',
  investigate: 'fix',
  build: 'build',
  complete: 'build',
  refactor: 'refactor',
  optimize: 'optimize',
  upgrade: 'upgrade',
};

/** The i18n key of the comment for a failed Gate 2, which depends on what the ticket asked for. */
export function gate2FailedKey(type: TicketType): string {
  return `qa.comment.gate2FailedByType.${TEXT_GROUP[type]}`;
}

/** The i18n key of the line that introduces the reference solution in Code Review. */
export function referenceIntroKey(type: TicketType): string {
  return `review.referenceIntroByType.${TEXT_GROUP[type]}`;
}
