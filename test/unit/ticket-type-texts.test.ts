import { describe, expect, it } from 'vitest';
import en from '../../src/renderer/src/locales/en.json';
import pt from '../../src/renderer/src/locales/pt.json';
import { TICKET_TYPES, gate2FailedKey, referenceIntroKey } from '../../src/shared/ticketMeta.ts';

type Texts = Record<string, unknown>;
const at = (texts: Texts, key: string): unknown => key.split('.').reduce<unknown>((value, part) => (value as Texts | undefined)?.[part], texts);

describe.each([
  ['en', en as Texts],
  ['pt', pt as Texts],
])('texts by ticket type (%s)', (_language, texts) => {
  it.each(TICKET_TYPES)('names the type %s', (type) => {
    expect(at(texts, `ticketType.${type}`)).toEqual(expect.stringMatching(/\S/));
  });

  it.each(TICKET_TYPES)('has the failed Gate 2 comment and the review introduction of %s', (type) => {
    expect(at(texts, gate2FailedKey(type))).toEqual(expect.stringMatching(/\S/));
    // The review introduction names the senior developer.
    expect(at(texts, referenceIntroKey(type))).toEqual(expect.stringContaining('{{name}}'));
  });

  it('no longer has one text for every type', () => {
    expect(at(texts, 'qa.comment.gate2Failed')).toBeUndefined();
    expect(at(texts, 'review.referenceIntro')).toBeUndefined();
  });

  it('speaks of a bug only for fix and investigate tickets', () => {
    for (const type of TICKET_TYPES) {
      const speaksOfBug = /\bbug\b/i.test(String(at(texts, gate2FailedKey(type))));
      expect(speaksOfBug, type).toBe(type === 'fix' || type === 'investigate' || type === 'test');
    }
  });
});

describe('texts by ticket type', () => {
  it('says what each kind of ticket still misses when Gate 2 fails', () => {
    expect(at(en, 'qa.comment.gate2FailedByType.optimize')).toBe('The goal of the ticket is not reached yet.');
    expect(at(pt, 'qa.comment.gate2FailedByType.optimize')).toBe('A meta do ticket ainda não foi atingida.');
    expect(at(en, 'qa.comment.gate2FailedByType.build')).toBe('The ticket is not delivered yet. Part of what it asks for is still missing or does not work.');
    expect(at(en, 'qa.comment.gate2FailedByType.fix')).toBe('The reported bug is still unresolved. The app still shows the behavior described in the ticket.');
  });

  it('calls the development button "Solve ticket"', () => {
    expect(at(en, 'board.solveBug')).toBe('Solve ticket');
    expect(at(pt, 'board.solveBug')).toBe('Resolver ticket');
  });
});
