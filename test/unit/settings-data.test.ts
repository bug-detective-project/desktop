import { describe, expect, it } from 'vitest';
import { parseMinutes, toMinutes } from '../../src/shared/duration.ts';
import * as rules from '../../src/shared/kanban.ts';
import { backupStatus } from '../../src/shared/types.ts';

const ctx = (now: string) => ({ now, id: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`; })() });

describe('QA time limit in minutes', () => {
  it('shows seconds as minutes', () => {
    expect(toMinutes(180)).toBe('3');
    expect(toMinutes(30)).toBe('0.5');
    expect(toMinutes(1800)).toBe('30');
    expect(toMinutes(45)).toBe('0.75');
  });

  it('reads the minutes back into seconds, with a dot or a comma', () => {
    expect(parseMinutes('3')).toBe(180);
    expect(parseMinutes(' 2.5 ')).toBe(150);
    expect(parseMinutes('2,5')).toBe(150);
    expect(parseMinutes(toMinutes(45))).toBe(45);
  });

  it('rejects text that is not a number of minutes', () => {
    for (const text of ['', 'abc', '-1', '3 min', '1e2', '.5']) {
      expect(parseMinutes(text)).toBeNull();
    }
  });
});

describe('backup status', () => {
  const start = rules.createInitialState(ctx('2026-10-20T10:00:00.000Z'));
  const unlocked = rules.unlockTicket(start, 1, 'abc', ctx('2026-10-21T10:00:00.000Z'));

  it('has nothing to protect before the first ticket', () => {
    expect(backupStatus(start)).toBe('none');
  });

  it('is outdated until the first export', () => {
    expect(backupStatus(unlocked)).toBe('outdated');
    expect(backupStatus({ ...unlocked, lastExport: null })).toBe('outdated');
  });

  it('is current right after an export, and outdated again once the game changes', () => {
    const exported = { ...unlocked, lastExport: { at: '2026-10-22T10:00:00.000Z', path: 'C:\\Saves\\bug-detective-2026-10-22.bdsave' } };
    expect(backupStatus(exported)).toBe('current');
    expect(backupStatus(rules.playerMove(exported, 1, 'inProgress', ctx('2026-10-23T10:00:00.000Z')))).toBe('outdated');
    const working = { ...rules.playerMove(unlocked, 1, 'inProgress', ctx('2026-10-21T11:00:00.000Z')), lastExport: exported.lastExport };
    expect(backupStatus(working)).toBe('current');
    expect(backupStatus(rules.revealHint(working, 1, 3, ctx('2026-10-23T10:00:00.000Z')))).toBe('outdated');
  });
});
