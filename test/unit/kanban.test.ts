import { describe, expect, it } from 'vitest';
import * as rules from '../../src/shared/kanban.ts';
import type { RuleContext } from '../../src/shared/kanban.ts';
import { COLUMNS } from '../../src/shared/types.ts';
import type { Column, GameState, QaResult, TrackChoice } from '../../src/shared/types.ts';
import { unlocked } from '../helpers/tickets.ts';

function context(): RuleContext {
  let next = 0;
  return { now: '2026-10-26T10:00:00.000Z', id: () => `id-${(next += 1)}` };
}

const ctx = context();
const result = (status: QaResult['status'], gate: 1 | 2 = 2): QaResult => ({
  ticket: 1,
  gate,
  status,
  message: '',
  tests: [
    { name: 'a passing test', status: 'passed' },
    ...(status === 'failed' ? [{ name: 'a failing test', status: 'failed' as const, error: 'boom' }] : []),
    ...(status === 'timeout' ? [{ name: 'an unfinished test', status: 'unfinished' as const }] : []),
  ],
  durationMs: 1000,
});
const outcome = (status: QaResult['status'], gate: 1 | 2 = 2) => ({
  startedAt: ctx.now,
  branch: 'player/ticket-1',
  branchWarning: false,
  timeoutSeconds: 180,
  result: result(status, gate),
  playerDiff: 'diff --git a/x b/x',
});

function withTicket(status: Column = 'todo'): GameState {
  let state = rules.unlockTicket(rules.createInitialState(ctx), 1, unlocked(1, 'abc'), ctx);
  const path: Column[] = ['inProgress', 'inQa', 'codeReview', 'done'];
  for (const step of path.slice(0, path.indexOf(status) + 1)) {
    if (step === 'inProgress' || step === 'inQa') {
      state = rules.playerMove(state, 1, step, ctx);
    } else if (step === 'codeReview') {
      state = rules.recordQaResult(state, 1, outcome('passed'), ctx);
    } else {
      state = rules.acceptReview(state, 1, ctx);
    }
  }
  return state;
}

const ticketStatus = (state: GameState, ticket = 1) => rules.findTicket(state, ticket)!.status;

describe('initial state', () => {
  it('starts with no ticket and a welcome message', () => {
    const state = rules.createInitialState(ctx, 'pt');
    expect(state.currentTicket).toBeNull();
    expect(state.inbox.map((message) => message.kind)).toEqual(['welcome']);
    expect(state.settings).toEqual({ language: 'pt', qaTimeoutSeconds: 180, theme: 'system' });
    expect(rules.canTakeTicket(state)).toBe(true);
  });
});

describe('player moves', () => {
  const allowed = [
    ['todo', 'inProgress'],
    ['inProgress', 'inQa'],
  ];

  for (const from of COLUMNS) {
    for (const to of COLUMNS) {
      const ok = allowed.some(([a, b]) => a === from && b === to);
      it(`${ok ? 'allows' : 'forbids'} ${from} → ${to}`, () => {
        expect(rules.isPlayerMoveAllowed(from, to)).toBe(ok);
        const state = withTicket(from);
        if (ok) {
          expect(ticketStatus(rules.playerMove(state, 1, to, ctx))).toBe(to);
        } else {
          expect(() => rules.playerMove(state, 1, to, ctx)).toThrow(expect.objectContaining({ code: 'moveNotAllowed' }));
        }
      });
    }
  }

  it('cannot cancel QA', () => {
    const state = withTicket('inQa');
    expect(() => rules.playerMove(state, 1, 'inProgress', ctx)).toThrow(expect.objectContaining({ code: 'moveNotAllowed' }));
    expect(() => rules.playerMove(state, 1, 'todo', ctx)).toThrow(expect.objectContaining({ code: 'moveNotAllowed' }));
  });

  it('marks QA as started when the card enters In QA', () => {
    const state = withTicket('inQa');
    expect(rules.findTicket(state, 1)!.qaStartedAt).toBe(ctx.now);
  });

  it('only moves the active ticket', () => {
    const state = withTicket('todo');
    expect(() => rules.playerMove(state, 2, 'inProgress', ctx)).toThrow(expect.objectContaining({ code: 'noSuchTicket' }));
  });

  it('appends every transition to the activity log', () => {
    const state = withTicket('done');
    expect(state.activity.map((entry) => [entry.from, entry.to, entry.actor])).toEqual([
      [null, 'todo', 'system'],
      ['todo', 'inProgress', 'player'],
      ['inProgress', 'inQa', 'player'],
      ['inQa', 'codeReview', 'system'],
      ['codeReview', 'done', 'player'],
    ]);
  });
});

describe('one active ticket at a time', () => {
  it('unlocks the next ticket only after the current one is Done', () => {
    for (const status of ['todo', 'inProgress', 'inQa', 'codeReview'] as Column[]) {
      const state = withTicket(status);
      expect(rules.canTakeTicket(state)).toBe(false);
      expect(() => rules.unlockTicket(state, 2, unlocked(2, 'def'), ctx)).toThrow(expect.objectContaining({ code: 'ticketNotDone' }));
    }
    const done = withTicket('done');
    expect(rules.canTakeTicket(done)).toBe(true);
    const next = rules.unlockTicket(done, 2, unlocked(2, 'def'), ctx);
    expect(next.currentTicket).toBe(2);
    expect(next.inbox.filter((message) => message.kind === 'assignment').map((message) => message.ticket)).toEqual([1, 2]);
  });

  it('unlocks tickets in order', () => {
    expect(() => rules.unlockTicket(rules.createInitialState(ctx), 2, unlocked(2, 'x'), ctx)).toThrow(expect.objectContaining({ code: 'wrongTicket' }));
  });

  it('makes Done tickets read-only', () => {
    let state = withTicket('done');
    state = rules.unlockTicket(state, 2, unlocked(2, 'def'), ctx);
    for (const to of COLUMNS) {
      expect(() => rules.playerMove(state, 1, to, ctx)).toThrow(expect.objectContaining({ code: 'notActiveTicket' }));
    }
    expect(() => rules.revealHint(state, 1, 3, ctx)).toThrow(expect.objectContaining({ code: 'notActiveTicket' }));
  });

  it('sends the completion message after the last ticket of the only track', () => {
    let state = rules.createInitialState(ctx);
    for (let ticket = 1; ticket <= 4; ticket += 1) {
      state = rules.unlockTicket(state, ticket, unlocked(ticket, 'x'), ctx);
      state = rules.playerMove(state, ticket, 'inProgress', ctx);
      state = rules.playerMove(state, ticket, 'inQa', ctx);
      state = rules.recordQaResult(state, ticket, { ...outcome('passed'), result: { ...result('passed'), ticket } }, ctx);
      state = rules.acceptReview(state, ticket, ctx);
    }
    expect(state.inbox.at(-1)!.kind).toBe('completion');
    expect(rules.nextIdFor(state, state.tracks!, 'front')).toBeNull();
    expect(() => rules.unlockTicket(state, 5, unlocked(5, 'x'), ctx)).toThrow(expect.objectContaining({ code: 'noMoreTickets' }));
  });
});

describe('career tracks', () => {
  const counts = { front: 2, back: 2 };
  const finish = (state: GameState, ticket: number) => {
    let next = rules.playerMove(state, ticket, 'inProgress', ctx);
    next = rules.playerMove(next, ticket, 'inQa', ctx);
    next = rules.recordQaResult(next, ticket, { ...outcome('passed'), result: { ...result('passed'), ticket } }, ctx);
    return rules.acceptReview(next, ticket, ctx);
  };
  /** Unlocks and finishes the next ticket of a track choice. */
  const play = (state: GameState, choice: TrackChoice) => {
    const id = rules.nextIdFor(state, counts, choice)!;
    const ticket = state.tickets.length + 1;
    return finish(rules.unlockTicket(state, ticket, unlocked(ticket, 'x', counts, id), ctx), ticket);
  };
  const completions = (state: GameState) => state.inbox.filter((m) => m.kind === 'completion' || m.kind === 'trackCompletion').map((m) => `${m.kind}:${m.track}`);

  it('gives the next ticket of each track in order', () => {
    const state = rules.createInitialState(ctx);
    expect(rules.nextIdFor(state, counts, 'front')).toBe('front-1');
    expect(rules.nextIdFor(state, counts, 'back')).toBe('back-1');
    const after = play(state, 'back');
    expect(rules.nextIdFor(after, counts, 'back')).toBe('back-2');
    expect(rules.nextIdFor(after, counts, 'front')).toBe('front-1');
  });

  it('alternates on fullstack, starting with front, and falls back to the other track', () => {
    let state = rules.createInitialState(ctx);
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      ids.push(rules.nextIdFor(state, counts, 'fullstack')!);
      state = play(state, 'fullstack');
    }
    expect(ids).toEqual(['front-1', 'back-1', 'front-2', 'back-2']);
    expect(rules.nextIdFor(state, counts, 'fullstack')).toBeNull();

    let skewed = play(play(rules.createInitialState(ctx), 'front'), 'front');
    expect(rules.nextIdFor(skewed, counts, 'fullstack')).toBe('back-1');
    skewed = play(skewed, 'back');
    expect(rules.nextIdFor(skewed, counts, 'fullstack')).toBe('back-2');
  });

  it('records the ticket id, track, commit and manifest version', () => {
    const state = rules.unlockTicket(rules.createInitialState(ctx), 1, { ...unlocked(1, 'abc', counts, 'back-1'), manifestVersion: '2.0.0' }, ctx);
    expect(state.tracks).toEqual(counts);
    expect(state.tickets[0]).toMatchObject({ ticket: 1, id: 'back-1', track: 'back', stageCommit: 'abc', manifestVersion: '2.0.0' });
  });

  it('refuses a ticket already unlocked, or a new one before the current is done', () => {
    const one = rules.unlockTicket(rules.createInitialState(ctx), 1, unlocked(1, 'x', counts), ctx);
    expect(() => rules.unlockTicket(one, 2, unlocked(2, 'x', counts, 'back-1'), ctx)).toThrow(expect.objectContaining({ code: 'ticketNotDone' }));
    const done = finish(one, 1);
    expect(() => rules.unlockTicket(done, 2, unlocked(2, 'x', counts, 'front-1'), ctx)).toThrow(expect.objectContaining({ code: 'wrongTicket' }));
  });

  it('completes the project with the first track, then each other track once', () => {
    let state = play(play(rules.createInitialState(ctx), 'back'), 'back');
    expect(completions(state)).toEqual(['completion:back']);
    state = play(state, 'front');
    expect(completions(state)).toEqual(['completion:back']);
    state = play(state, 'front');
    expect(completions(state)).toEqual(['completion:back', 'trackCompletion:front', 'trackCompletion:fullstack']);
    expect(rules.nextIdFor(state, counts, 'front')).toBeNull();
  });

  it('ends a track early when a newer publication has fewer tickets in it', () => {
    let state = play(rules.createInitialState(ctx), 'back');
    state = rules.setTrackCounts(state, { front: 2, back: 1 }, ctx);
    expect(state.tracks).toEqual({ front: 2, back: 1 });
    expect(rules.nextIdFor(state, state.tracks!, 'back')).toBeNull();
    expect(completions(state)).toEqual(['completion:back']);
    // Never below the tickets already unlocked.
    expect(rules.setTrackCounts(state, { front: 2, back: 0 }, ctx).tracks).toEqual({ front: 2, back: 1 });
  });

  it('only offers a ticket when the current one is done', () => {
    const one = rules.unlockTicket(rules.createInitialState(ctx), 1, unlocked(1, 'x', counts), ctx);
    expect(rules.canTakeTicket(one)).toBe(false);
    expect(rules.canTakeTicket(finish(one, 1))).toBe(true);
  });
});
