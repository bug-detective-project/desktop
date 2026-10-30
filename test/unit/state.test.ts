import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as rules from '../../src/shared/kanban.ts';
import { StateStore, StateVersionError, migrateState } from '../../src/main/services/state.ts';

const ctx = { now: '2026-10-26T10:00:00.000Z', id: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`; })() };

let dir: string;
beforeEach(async () => {
  // A path with a space and non-ASCII characters, like C:\Users\João Silva\AppData\Roaming.
  dir = await mkdtemp(join(tmpdir(), 'João Silva-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('StateStore', () => {
  it('starts a new game when there is no saved state', async () => {
    const { state, recovered } = await new StateStore(dir).load(ctx, 'pt');
    expect(recovered).toBe(false);
    expect(state.schemaVersion).toBe(3);
    expect(state.settings.language).toBe('pt');
  });

  it('saves atomically and loads the same state back', async () => {
    const store = new StateStore(dir);
    let state = rules.unlockTicket(rules.createInitialState(ctx), 1, 'abc', ctx);
    state = rules.playerMove(state, 1, 'inProgress', ctx);
    await store.save(state);
    expect(await readdir(dir)).toEqual(['state.json']);
    expect((await new StateStore(dir).load(ctx)).state).toEqual(state);
  });

  it('serializes concurrent saves so the last one wins', async () => {
    const store = new StateStore(dir);
    const base = rules.createInitialState(ctx);
    await Promise.all(
      [1, 2, 3, 4, 5].map((n) => store.save({ ...base, settings: { ...base.settings, qaTimeoutSeconds: 60 * n } })),
    );
    const saved = JSON.parse(await readFile(store.file, 'utf8'));
    expect(saved.settings.qaTimeoutSeconds).toBe(300);
  });

  it('keeps a corrupt file aside and starts a new game', async () => {
    await writeFile(join(dir, 'state.json'), '{ not json');
    const { state, recovered } = await new StateStore(dir).load(ctx);
    expect(recovered).toBe(true);
    expect(state.tickets).toEqual([]);
    expect((await readdir(dir)).some((name) => /^state\.corrupt-\d+\.json$/.test(name))).toBe(true);
  });

  it('refuses a state written by a newer version instead of discarding it', async () => {
    await writeFile(join(dir, 'state.json'), JSON.stringify({ schemaVersion: 99 }));
    await expect(new StateStore(dir).load(ctx)).rejects.toThrow(StateVersionError);
    expect(await readdir(dir)).toEqual(['state.json']);
  });
});

describe('migrations', () => {
  const v1 = {
    version: 1,
    createdAt: '2026-10-01T09:00:00.000Z',
    currentTicket: 2,
    tickets: [
      { ticket: 1, status: 'done', attempts: [], comments: [], hintsUsed: 3, solutionShown: true, reviewAccepted: true },
      { ticket: 2, status: 'inQa', attempts: [], comments: [], hintsUsed: 1, solutionShown: false, reviewAccepted: false },
    ],
    log: [
      { ticket: 1, from: null, to: 'todo', at: '2026-10-01T09:05:00.000Z' },
      { ticket: 1, from: 'codeReview', to: 'done', at: '2026-10-02T09:00:00.000Z' },
      { ticket: 2, from: null, to: 'todo', at: '2026-10-02T09:01:00.000Z' },
    ],
    settings: { language: 'pt' },
  };

  it('loads a QA limit under the 1-minute minimum (older versions allowed 30 s) as 1 minute', () => {
    const base = rules.createInitialState(ctx);
    expect(migrateState({ ...base, settings: { ...base.settings, qaTimeoutSeconds: 45 } }, ctx).settings.qaTimeoutSeconds).toBe(60);
    expect(migrateState({ ...base, settings: { ...base.settings, qaTimeoutSeconds: 240 } }, ctx).settings.qaTimeoutSeconds).toBe(240);
    expect(() => migrateState({ ...base, settings: { ...base.settings, qaTimeoutSeconds: 5000 } }, ctx)).toThrow();
  });

  it('migrates version 1 to the current schema', () => {
    const state = migrateState(v1, ctx);
    expect(state.schemaVersion).toBe(3);
    expect(state.settings).toEqual({ language: 'pt', qaTimeoutSeconds: 180, theme: 'system' });
    expect(state.tickets[0]).toMatchObject({
      hintsRevealed: 3,
      solutionRevealed: true,
      reviewAcceptedAt: '2026-10-02T09:00:00.000Z',
      unlockedAt: '2026-10-01T09:05:00.000Z',
    });
    expect(state.tickets[0].conversation.filter((entry) => entry.kind === 'hint')).toHaveLength(3);
    expect(state.tickets[1]).toMatchObject({ status: 'inQa', hintsRevealed: 1, reviewAcceptedAt: null });
    expect(state.activity).toHaveLength(3);
    expect(state.inbox.map((message) => message.kind)).toEqual(['welcome', 'assignment', 'assignment']);
  });

  it('loads and re-saves a migrated file', async () => {
    await writeFile(join(dir, 'state.json'), JSON.stringify(v1));
    const store = new StateStore(dir);
    const { state } = await store.load(ctx);
    // A ticket that was in QA in the old file is then recovered like any interrupted run.
    const recovered = rules.recoverInterruptedQa(state, ctx);
    expect(rules.findTicket(recovered, 2)!.status).toBe('inProgress');
    await store.save(recovered);
    expect(JSON.parse(await readFile(store.file, 'utf8')).schemaVersion).toBe(3);
  });

  it('rejects state without a version and invalid current state', () => {
    expect(() => migrateState({}, ctx)).toThrow(StateVersionError);
    const state = rules.createInitialState(ctx);
    expect(() => migrateState({ ...state, settings: { ...state.settings, language: 'fr' } }, ctx)).toThrow();
    expect(() => migrateState({ ...state, tickets: [{ ticket: 1, status: 'archived' }] }, ctx)).toThrow();
  });

  it('rejects a state whose fields disagree with the Kanban rules', () => {
    const done = (state: ReturnType<typeof rules.createInitialState>, ticket: number) =>
      rules.acceptReview({ ...state, tickets: state.tickets.map((item) => (item.ticket === ticket ? { ...item, status: 'codeReview' as const } : item)) }, ticket, ctx);
    let two = rules.unlockTicket(rules.createInitialState(ctx), 1, 'a', ctx);
    two = rules.unlockTicket(done(two, 1), 2, 'b', ctx);
    // A state the rules made is valid.
    expect(migrateState(two, ctx)).toEqual(two);

    const invalid = {
      'the current ticket is missing': { ...two, currentTicket: 3 },
      'the current ticket is not the last one': { ...two, currentTicket: 1 },
      'tickets but no current ticket': { ...two, currentTicket: null },
      'a repeated ticket': { ...two, tickets: [two.tickets[0], two.tickets[0]], currentTicket: 1 },
      'a gap in the tickets': { ...two, tickets: [two.tickets[1]] },
      'an unfinished ticket before the last': { ...two, tickets: [{ ...two.tickets[0], status: 'inProgress' }, two.tickets[1]] },
      'too many tickets': {
        ...two,
        tickets: [1, 2, 3, 4, 5].map((ticket) => ({ ...two.tickets[0], ticket, status: 'done' })),
        currentTicket: 5,
      },
      'a review of a locked ticket': {
        ...two,
        reviewSession: {
          ticket: 3,
          phase: 'open',
          startedAt: ctx.now,
          returnPoint: { branch: null, head: 'a'.repeat(40), indexTree: 'b'.repeat(40), excludesFile: null },
          wipCommit: null,
        },
      },
    };
    for (const [name, state] of Object.entries(invalid)) {
      expect(() => migrateState(state, ctx), name).toThrow();
    }
  });

  it('keeps an incoherent state file aside and starts a new game, instead of failing on every start', async () => {
    const state = rules.unlockTicket(rules.createInitialState(ctx), 1, 'a', ctx);
    await writeFile(join(dir, 'state.json'), JSON.stringify({ ...state, currentTicket: 3 }));
    const { state: loaded, recovered } = await new StateStore(dir).load(ctx);
    expect(recovered).toBe(true);
    expect(loaded.tickets).toEqual([]);
    expect((await readdir(dir)).some((name) => /^state\.corrupt-\d+\.json$/.test(name))).toBe(true);
  });
});
