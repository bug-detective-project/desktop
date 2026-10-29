/** Rafaela's onboarding: its steps and where each balloon goes, as pure data and functions (unit-tested). */

export type OnboardingView = 'dashboard' | 'board';

/** A miniature drawn in the balloon instead of real game data: the board's steps need no real ticket. */
export type OnboardingIllustration = 'flow' | 'card';

/** The tabs of the example ticket panel, as in the real one. */
export type DemoTab = 'ticket' | 'qa' | 'history' | 'senior';

export interface OnboardingStep {
  /** Its texts are `onboarding.steps.<id>.title` and `.body`. */
  id: string;
  view: OnboardingView;
  /** CSS selectors; the highlight covers all their elements. None: a centered balloon over the dimmed screen. */
  targets: string[];
  illustration?: OnboardingIllustration;
  /** Opens the example ticket panel (never a real ticket) on this tab. */
  panelTab?: DemoTab;
  /** Header buttons: the balloon goes below them first. */
  below?: boolean;
}

/** A part of the example ticket panel, and one of its tabs. */
const demo = (part: string) => `[data-onboarding-demo="${part}"]`;
const demoTab = (tab: DemoTab) => `${demo('panel')} [data-testid="tab-${tab}"]`;

export const ONBOARDING_STEPS: OnboardingStep[] = [
  { id: 'currentTask', view: 'dashboard', targets: ['[data-tour="current-task"]'] },
  { id: 'environment', view: 'dashboard', targets: ['[data-testid="environment-card"]'] },
  { id: 'client', view: 'dashboard', targets: ['[data-testid="desk-client"]', '[data-testid="project-drawer-toggle"]'] },
  { id: 'inbox', view: 'dashboard', targets: ['[data-tour="inbox"]'] },
  { id: 'message', view: 'dashboard', targets: ['[data-testid="message"]'] },
  { id: 'board', view: 'dashboard', targets: ['[data-testid="nav-board"]'], below: true },
  { id: 'columns', view: 'board', targets: ['[data-tour="columns"] > section > header'], illustration: 'flow' },
  { id: 'card', view: 'board', targets: ['[data-testid="column-todo"]'], illustration: 'card' },
  { id: 'qa', view: 'board', targets: ['[data-testid="column-inQa"]'] },
  { id: 'ticketOpen', view: 'board', targets: [demo('panel')], panelTab: 'ticket' },
  { id: 'ticketHeader', view: 'board', targets: [demo('header')], panelTab: 'ticket' },
  { id: 'ticketActions', view: 'board', targets: [demo('actions')], panelTab: 'ticket' },
  { id: 'ticketTab', view: 'board', targets: [demoTab('ticket'), demo('content')], panelTab: 'ticket' },
  { id: 'qaTab', view: 'board', targets: [demoTab('qa'), demo('content')], panelTab: 'qa' },
  { id: 'historyTab', view: 'board', targets: [demoTab('history'), demo('content')], panelTab: 'history' },
  { id: 'seniorTab', view: 'board', targets: [demoTab('senior'), demo('content')], panelTab: 'senior' },
  { id: 'review', view: 'board', targets: ['[data-testid="column-codeReview"]', '[data-testid="column-done"]'] },
  { id: 'settings', view: 'board', targets: ['[data-testid="nav-settings"]'], below: true },
  { id: 'replay', view: 'board', targets: ['[data-testid="onboarding-replay"]'], below: true },
];

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Space between the highlight and the balloon, and between the balloon and the window edges. */
const GAP = 16;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, Math.max(min, max)));

/**
 * Where the balloon goes: beside the target (right, then left), else below or above it, else
 * centered over it. It always stays inside the window.
 */
export function placeBalloon(
  target: Box | null,
  balloon: { width: number; height: number },
  viewport: { width: number; height: number },
  below = false,
): { left: number; top: number } {
  const centered = {
    left: clamp((viewport.width - balloon.width) / 2, GAP, viewport.width - balloon.width - GAP),
    top: clamp((viewport.height - balloon.height) / 2, GAP, viewport.height - balloon.height - GAP),
  };
  if (!target) {
    return centered;
  }
  const beside = (left: number) => ({ left, top: clamp(target.top, GAP, viewport.height - balloon.height - GAP) });
  const across = (top: number) => ({ left: clamp(target.left + target.width / 2 - balloon.width / 2, GAP, viewport.width - balloon.width - GAP), top });
  const right = target.left + target.width + GAP;
  const left = target.left - GAP - balloon.width;
  const bottom = target.top + target.height + GAP;
  const top = target.top - GAP - balloon.height;
  const sides = [
    { fits: right + balloon.width <= viewport.width - GAP, place: () => beside(right) },
    { fits: left >= GAP, place: () => beside(left) },
    { fits: bottom + balloon.height <= viewport.height - GAP, place: () => across(bottom) },
    { fits: top >= GAP, place: () => across(top) },
  ];
  const order = below ? [sides[2], sides[0], sides[1], sides[3]] : sides;
  return order.find((side) => side.fits)?.place() ?? centered;
}

/** The box around every target's element, or null when none is on screen. */
export function unionBox(boxes: Box[]): Box | null {
  const visible = boxes.filter((box) => box.width > 0 && box.height > 0);
  if (visible.length === 0) {
    return null;
  }
  const left = Math.min(...visible.map((box) => box.left));
  const top = Math.min(...visible.map((box) => box.top));
  const right = Math.max(...visible.map((box) => box.left + box.width));
  const bottom = Math.max(...visible.map((box) => box.top + box.height));
  return { left, top, width: right - left, height: bottom - top };
}
