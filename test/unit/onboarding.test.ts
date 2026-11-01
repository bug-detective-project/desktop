import { describe, expect, it } from 'vitest';
import { parseState } from '../../src/main/services/state.ts';
import en from '../../src/renderer/src/locales/en.json';
import pt from '../../src/renderer/src/locales/pt.json';
import { ONBOARDING_STEPS, placeBalloon, unionBox } from '../../src/renderer/src/components/onboardingSteps.ts';
import * as rules from '../../src/shared/kanban.ts';
import { unlocked } from '../helpers/tickets.ts';

const ctx = { now: '2026-10-29T10:00:00.000Z', id: () => '00000000-0000-4000-8000-000000000001' };

describe('onboardingDue', () => {
  it('is due in a new game until the onboarding is finished', () => {
    const fresh = rules.createInitialState(ctx);
    expect(rules.onboardingDue(fresh)).toBe(true);
    const finished = rules.finishOnboarding(fresh);
    expect(finished.onboardingSeen).toBe(true);
    expect(rules.onboardingDue(finished)).toBe(false);
  });

  it('counts a game with an unlocked ticket as seen: a save from before the onboarding is not interrupted', () => {
    const playing = rules.unlockTicket(rules.createInitialState(ctx), 1, unlocked(1, null), ctx);
    expect(playing.onboardingSeen).toBeUndefined();
    expect(rules.onboardingDue(playing)).toBe(false);
  });

  it('loads state files with and without the flag', () => {
    const fresh = rules.createInitialState(ctx);
    expect(parseState(fresh).onboardingSeen).toBeUndefined();
    expect(parseState({ ...fresh, onboardingSeen: true }).onboardingSeen).toBe(true);
    expect(() => parseState({ ...fresh, onboardingSeen: 'yes' })).toThrow();
  });
});

describe('the onboarding steps', () => {
  it('go through the Dashboard, then the Board, and end on the header buttons', () => {
    expect(ONBOARDING_STEPS.map((step) => step.id)).toEqual([
      'currentTask',
      'environment',
      'client',
      'inbox',
      'message',
      'board',
      'columns',
      'card',
      'qa',
      'ticketOpen',
      'ticketHeader',
      'ticketActions',
      'ticketTab',
      'qaTab',
      'historyTab',
      'seniorTab',
      'review',
      'settings',
      'replay',
    ]);
    const firstBoard = ONBOARDING_STEPS.findIndex((step) => step.view === 'board');
    expect(ONBOARDING_STEPS.slice(0, firstBoard).every((step) => step.view === 'dashboard')).toBe(true);
    expect(ONBOARDING_STEPS.slice(firstBoard).every((step) => step.view === 'board')).toBe(true);
    // The example ticket panel opens on each of its tabs, in the real panel's order.
    expect(ONBOARDING_STEPS.flatMap((step) => (step.panelTab ? [step.panelTab] : []))).toEqual(['ticket', 'ticket', 'ticket', 'ticket', 'qa', 'history', 'senior']);
  });

  it('have a title and a text in English and Portuguese', () => {
    for (const locale of [en, pt]) {
      const steps = locale.onboarding.steps as Record<string, { title: string; body: string }>;
      for (const step of ONBOARDING_STEPS) {
        expect(steps[step.id]?.title, step.id).toBeTruthy();
        expect(steps[step.id]?.body, step.id).toBeTruthy();
      }
      expect(locale.onboarding.demo.ticketMarkdown).toBeTruthy();
      expect(Object.keys(steps)).toHaveLength(ONBOARDING_STEPS.length);
    }
  });
});

describe('placeBalloon', () => {
  const balloon = { width: 340, height: 200 };
  const viewport = { width: 1280, height: 640 };

  it('goes to the right of the target, then to the left', () => {
    expect(placeBalloon({ left: 24, top: 90, width: 320, height: 160 }, balloon, viewport)).toEqual({ left: 360, top: 90 });
    expect(placeBalloon({ left: 760, top: 90, width: 500, height: 520 }, balloon, viewport)).toEqual({ left: 404, top: 90 });
  });

  it('goes below a header button when asked, centered on it and inside the window', () => {
    expect(placeBalloon({ left: 380, top: 8, width: 100, height: 48 }, balloon, viewport, true)).toEqual({ left: 260, top: 72 });
    expect(placeBalloon({ left: 1136, top: 16, width: 32, height: 32 }, balloon, viewport, true)).toEqual({ left: 924, top: 64 });
  });

  it('stays inside the window vertically', () => {
    expect(placeBalloon({ left: 24, top: 560, width: 300, height: 60 }, balloon, viewport).top).toBe(640 - 200 - 16);
  });

  it('is centered without a target, or when no side has room', () => {
    expect(placeBalloon(null, balloon, viewport)).toEqual({ left: 470, top: 220 });
    expect(placeBalloon({ left: 10, top: 10, width: 1260, height: 620 }, balloon, viewport)).toEqual({ left: 470, top: 220 });
  });
});

describe('unionBox', () => {
  it('covers every visible element, and is null when none is on screen', () => {
    expect(
      unionBox([
        { left: 774, top: 174, width: 232, height: 442 },
        { left: 1022, top: 174, width: 234, height: 442 },
      ]),
    ).toEqual({ left: 774, top: 174, width: 482, height: 442 });
    expect(unionBox([{ left: 0, top: 0, width: 0, height: 0 }])).toBeNull();
    expect(unionBox([])).toBeNull();
  });
});
