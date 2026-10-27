import { describe, expect, it } from 'vitest';
import { formatDuration, parseDuration } from '../../src/shared/duration.ts';
import * as rules from '../../src/shared/kanban.ts';
import { backupStatus } from '../../src/shared/types.ts';

const ctx = (now: string) => ({ now, id: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`; })() });

describe('QA time limit text', () => {
  it('formats seconds as minutes and seconds', () => {
    expect(formatDuration(180)).toBe('3 min 00 s');
    expect(formatDuration(30)).toBe('0 min 30 s');
    expect(formatDuration(1805)).toBe('30 min 05 s');
  });

  it('reads what the player types back into seconds', () => {
    expect(parseDuration('3 min 00 s')).toBe(180);
    expect(parseDuration(formatDuration(1830))).toBe(1830);
    expect(parseDuration('  90 ')).toBe(90);
    expect(parseDuration('2:30')).toBe(150);
    expect(parseDuration('5m')).toBe(300);
    expect(parseDuration('1.5 min')).toBe(90);
    expect(parseDuration('45s')).toBe(45);
    expect(parseDuration('2 minutos 10 segundos')).toBe(130);
  });

  it('rejects text that is not a duration', () => {
    for (const text of ['', 'abc', '3 hours', '2:75', 'min', '1.33 min']) {
      expect(parseDuration(text)).toBeNull();
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
