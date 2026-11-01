import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as rules from '../../src/shared/kanban.ts';
import { StateStore, StateVersionError, parseState } from '../../src/main/services/state.ts';
import { unlocked } from '../helpers/tickets.ts';

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
    expect(state.schemaVersion).toBe(5);
    expect(state.settings.language).toBe('pt');
  });

  it('saves atomically and loads the same state back', async () => {
    const store = new StateStore(dir);
    let state = rules.unlockTicket(rules.createInitialState(ctx), 1, unlocked(1, 'abc'), ctx);
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

describe('state validation', () => {
  it('loads a QA limit under the 1-minute minimum (older versions allowed 30 s) as 1 minute', () => {
    const base = rules.createInitialState(ctx);
    expect(parseState({ ...base, settings: { ...base.settings, qaTimeoutSeconds: 45 } }).settings.qaTimeoutSeconds).toBe(60);
    expect(parseState({ ...base, settings: { ...base.settings, qaTimeoutSeconds: 240 } }).settings.qaTimeoutSeconds).toBe(240);
    expect(() => parseState({ ...base, settings: { ...base.settings, qaTimeoutSeconds: 5000 } })).toThrow();
  });

  it('keeps a state of an older schema aside and starts a new game, without migrating it', async () => {
    const old = { ...rules.createInitialState(ctx), schemaVersion: 4 };
    await writeFile(join(dir, 'state.json'), JSON.stringify(old));
    const { state, recovered } = await new StateStore(dir).load(ctx);
    expect(recovered).toBe(true);
    expect(state.schemaVersion).toBe(5);
    expect((await readdir(dir)).some((name) => /^state\.corrupt-\d+\.json$/.test(name))).toBe(true);
  });

  it('rejects a state with tickets but no track counts, a repeated id or a ticket of the wrong track', () => {
    const one = rules.unlockTicket(rules.createInitialState(ctx), 1, unlocked(1, 'a'), ctx);
    expect(() => parseState({ ...one, tracks: null })).toThrow();
    expect(() => parseState({ ...one, tickets: [{ ...one.tickets[0], track: 'back' }] })).toThrow();
    const done = { ...one, tickets: [{ ...one.tickets[0], status: 'done' }] };
    const twice = { ...done, currentTicket: 2, tickets: [done.tickets[0], { ...one.tickets[0], ticket: 2 }] };
    expect(() => parseState(twice)).toThrow();
  });

  it('rejects state without a version and invalid current state', () => {
    expect(() => parseState({})).toThrow(StateVersionError);
    const state = rules.createInitialState(ctx);
    expect(() => parseState({ ...state, settings: { ...state.settings, language: 'fr' } })).toThrow();
    expect(() => parseState({ ...state, tickets: [{ ticket: 1, status: 'archived' }] })).toThrow();
  });

  it('rejects a state whose fields disagree with the Kanban rules', () => {
    const done = (state: ReturnType<typeof rules.createInitialState>, ticket: number) =>
      rules.acceptReview({ ...state, tickets: state.tickets.map((item) => (item.ticket === ticket ? { ...item, status: 'codeReview' as const } : item)) }, ticket, ctx);
    let two = rules.unlockTicket(rules.createInitialState(ctx), 1, unlocked(1, 'a'), ctx);
    two = rules.unlockTicket(done(two, 1), 2, unlocked(2, 'b'), ctx);
    // A state the rules made is valid.
    expect(parseState(two)).toEqual(two);

    const invalid = {
      'the current ticket is missing': { ...two, currentTicket: 3 },
      'the current ticket is not the last one': { ...two, currentTicket: 1 },
      'tickets but no current ticket': { ...two, currentTicket: null },
      'a repeated ticket': { ...two, tickets: [two.tickets[0], two.tickets[0]], currentTicket: 1 },
      'a gap in the tickets': { ...two, tickets: [two.tickets[1]] },
      'an unfinished ticket before the last': { ...two, tickets: [{ ...two.tickets[0], status: 'inProgress' }, two.tickets[1]] },
      'more tickets than the tracks have': {
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
      expect(() => parseState(state), name).toThrow();
    }
  });

  it('keeps an incoherent state file aside and starts a new game, instead of failing on every start', async () => {
    const state = rules.unlockTicket(rules.createInitialState(ctx), 1, unlocked(1, 'a'), ctx);
    await writeFile(join(dir, 'state.json'), JSON.stringify({ ...state, currentTicket: 3 }));
    const { state: loaded, recovered } = await new StateStore(dir).load(ctx);
    expect(recovered).toBe(true);
    expect(loaded.tickets).toEqual([]);
    expect((await readdir(dir)).some((name) => /^state\.corrupt-\d+\.json$/.test(name))).toBe(true);
  });
});
