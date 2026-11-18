import { describe, expect, it } from 'vitest';
import { TICKET_TYPES, gate2FailedKey, metaOfEntry, referenceIntroKey } from '../../src/shared/ticketMeta.ts';
import type { TicketType } from '../../src/shared/ticketMeta.ts';

describe('ticket metadata', () => {
  it('defaults to a fix ticket that touches one side', () => {
    expect(metaOfEntry(undefined)).toEqual({ type: 'fix', bothSides: false });
    expect(metaOfEntry({})).toEqual({ type: 'fix', bothSides: false });
  });

  it('keeps what the entry says', () => {
    expect(metaOfEntry({ type: 'build', bothSides: true })).toEqual({ type: 'build', bothSides: true });
  });

  it('knows the seven ticket types', () => {
    expect(TICKET_TYPES).toEqual(['fix', 'build', 'complete', 'refactor', 'optimize', 'upgrade', 'investigate']);
  });

  it.each([
    ['fix', 'fix'],
    ['investigate', 'fix'],
    ['build', 'build'],
    ['complete', 'build'],
    ['refactor', 'refactor'],
    ['optimize', 'optimize'],
    ['upgrade', 'upgrade'],
  ] as [TicketType, string][])('%s uses the %s texts', (type, group) => {
    expect(gate2FailedKey(type)).toBe(`qa.comment.gate2FailedByType.${group}`);
    expect(referenceIntroKey(type)).toBe(`review.referenceIntroByType.${group}`);
  });
});
