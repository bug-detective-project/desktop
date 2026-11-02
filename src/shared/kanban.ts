/**
 * The Kanban rules as pure functions: each takes a state and returns a new one, or throws a
 * GameRuleError. The main process applies every change through these functions, so the rules
 * hold no matter what the renderer sends.
 */
import { DEFAULT_QA_TIMEOUT_SECONDS, SCHEMA_VERSION, TRACKS } from './types.ts';
import type {
  ActivityEntry,
  InboxMessage,
  ProjectProgress,
  Track,
  TrackChoice,
  TrackCounts,
  Column,
  GameState,
  Language,
  QaAttempt,
  QaComment,
  QaResult,
  TicketState,
} from './types.ts';

export type RuleCode =
  | 'noSuchTicket'
  | 'notActiveTicket'
  | 'ticketNotDone'
  | 'noMoreTickets'
  | 'wrongTicket'
  | 'moveNotAllowed'
  | 'wrongColumn'
  | 'noMoreHints'
  | 'hintsRemaining'
  | 'solutionAlreadyRevealed'
  | 'switchInProgress'
  | 'sameProject';

export class GameRuleError extends Error {
  readonly code: RuleCode;

  constructor(code: RuleCode, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

/** Clock and id source, injected so the rules stay deterministic in tests. */
export interface RuleContext {
  now: string;
  id: () => string;
}

/** The only moves a player may make. Every other transition is made by the system. */
export const PLAYER_MOVES: Readonly<Partial<Record<Column, readonly Column[]>>> = {
  todo: ['inProgress'],
  inProgress: ['inQa'],
};

export function isPlayerMoveAllowed(from: Column, to: Column): boolean {
  return PLAYER_MOVES[from]?.includes(to) ?? false;
}

export function createInitialState(ctx: RuleContext, language: Language = 'en'): GameState {
  return {
    schemaVersion: SCHEMA_VERSION,
    project: null,
    otherProjects: {},
    projectSources: {},
    projectSwitch: null,
    createdAt: ctx.now,
    currentTicket: null,
    tracks: null,
    tickets: [],
    activity: [],
    inbox: [{ id: ctx.id(), kind: 'welcome', at: ctx.now, read: false }],
    settings: { language, qaTimeoutSeconds: DEFAULT_QA_TIMEOUT_SECONDS, theme: 'system' },
    reviewSession: null,
  };
}

export function findTicket(state: GameState, ticket: number): TicketState | undefined {
  return state.tickets.find((item) => item.ticket === ticket);
}

function requireTicket(state: GameState, ticket: number): TicketState {
  const found = findTicket(state, ticket);
  if (!found) {
    throw new GameRuleError('noSuchTicket', `Ticket ${ticket} is not unlocked`);
  }
  return found;
}

function requireActive(state: GameState, ticket: number): TicketState {
  const found = requireTicket(state, ticket);
  if (state.currentTicket !== ticket) {
    throw new GameRuleError('notActiveTicket', `Ticket ${ticket} is not the active ticket`);
  }
  return found;
}

function requireColumn(ticket: TicketState, ...columns: Column[]): void {
  if (!columns.includes(ticket.status)) {
    throw new GameRuleError('wrongColumn', `Ticket ${ticket.ticket} is in ${ticket.status}, expected ${columns.join(' or ')}`);
  }
}

function updateTicket(state: GameState, ticket: number, change: (current: TicketState) => TicketState): GameState {
  return {
    ...state,
    tickets: state.tickets.map((item) => (item.ticket === ticket ? change(item) : item)),
  };
}

function move(
  state: GameState,
  ticket: number,
  to: Column,
  ctx: RuleContext,
  actor: ActivityEntry['actor'],
  reason: ActivityEntry['reason'],
  change: (current: TicketState) => TicketState = (current) => current,
): GameState {
  const from = requireTicket(state, ticket).status;
  const next = updateTicket(state, ticket, (current) => ({ ...change(current), status: to }));
  return { ...next, activity: [...next.activity, { ticket, from, to, at: ctx.now, actor, reason }] };
}

/** Whether a new ticket may be taken now: none is open, or the open one is Done. */
export function canTakeTicket(state: GameState): boolean {
  return state.currentTicket === null || requireTicket(state, state.currentTicket).status === 'done';
}

function orderOf(id: string): number {
  return Number(id.slice(id.indexOf('-') + 1));
}

/** The next ticket of a track: the first of its fixed queue that this game has not unlocked. */
function nextInTrack(state: GameState, counts: TrackCounts, track: Track): string | null {
  const taken = new Set(state.tickets.filter((item) => item.track === track).map((item) => orderOf(item.id)));
  for (let order = 1; order <= counts[track]; order += 1) {
    if (!taken.has(order)) {
      return `${track}-${order}`;
    }
  }
  return null;
}

/**
 * The ticket a track choice gives. Fullstack alternates with the track of the last unlocked ticket
 * (front first) and falls back to the other track when that one is finished.
 */
export function nextIdFor(state: GameState, counts: TrackCounts, choice: TrackChoice): string | null {
  if (choice !== 'fullstack') {
    return nextInTrack(state, counts, choice);
  }
  const last = state.tickets.at(-1)?.track;
  const first: Track = last === 'front' ? 'back' : 'front';
  const other: Track = first === 'front' ? 'back' : 'front';
  return nextInTrack(state, counts, first) ?? nextInTrack(state, counts, other);
}

/** What the content source said about the ticket being unlocked. */
export interface UnlockInfo {
  id: string;
  track: Track;
  commit: string | null;
  manifestVersion: string;
  /** The project's tickets per track in that manifest. */
  counts: TrackCounts;
}

export function unlockTicket(state: GameState, ticket: number, info: UnlockInfo, ctx: RuleContext): GameState {
  if (!canTakeTicket(state)) {
    throw new GameRuleError('ticketNotDone', `Ticket ${state.currentTicket} must be Done first`);
  }
  if (orderOf(info.id) > info.counts[info.track]) {
    throw new GameRuleError('noMoreTickets', `${info.id} is not in the project`);
  }
  if (ticket !== state.tickets.length + 1 || state.tickets.some((item) => item.id === info.id)) {
    throw new GameRuleError('wrongTicket', `Ticket ${state.tickets.length + 1} must be a ticket not unlocked yet, not ${info.id}`);
  }
  const created: TicketState = {
    ticket,
    id: info.id,
    track: info.track,
    manifestVersion: info.manifestVersion,
    status: 'todo',
    unlockedAt: ctx.now,
    stageCommit: info.commit,
    attempts: [],
    comments: [],
    hintsRevealed: 0,
    solutionRevealed: false,
    reviewAcceptedAt: null,
    qaStartedAt: null,
    playerDiff: null,
    conversation: [],
  };
  return {
    ...state,
    currentTicket: ticket,
    tracks: info.counts,
    tickets: [...state.tickets, created],
    activity: [...state.activity, { ticket, from: null, to: 'todo', at: ctx.now, actor: 'system', reason: 'unlocked' }],
    inbox: [...state.inbox, { id: ctx.id(), kind: 'assignment', ticket, at: ctx.now, read: false }],
  };
}

/** A move the player asked for (drag and drop). Moving to In QA marks QA as started. */
export function playerMove(state: GameState, ticket: number, to: Column, ctx: RuleContext): GameState {
  const current = requireActive(state, ticket);
  if (!isPlayerMoveAllowed(current.status, to)) {
    throw new GameRuleError('moveNotAllowed', `Moving ticket ${ticket} from ${current.status} to ${to} is not allowed`);
  }
  if (to === 'inQa') {
    return move(state, ticket, to, ctx, 'player', 'submitted', (item) => ({ ...item, qaStartedAt: ctx.now }));
  }
  return move(state, ticket, to, ctx, 'player', 'started');
}

/** Adds a warning comment when QA starts on a branch other than player/ticket-N. */
export function addBranchWarning(state: GameState, ticket: number, branch: string | null, ctx: RuleContext): GameState {
  const comment: QaComment = { id: ctx.id(), at: ctx.now, kind: 'branchWarning', branch };
  return updateTicket(state, ticket, (item) => ({ ...item, comments: [...item.comments, comment] }));
}

export function commentForResult(result: QaResult, attemptId: string, timeoutSeconds: number, ctx: RuleContext): QaComment {
  const base = { id: ctx.id(), at: ctx.now, attemptId };
  const failing = result.tests
    .filter((test) => test.status === 'failed')
    .map((test) => ({ name: test.name, ...(test.error !== undefined && { error: test.error }) }));
  if (result.status === 'passed') {
    return { ...base, kind: 'passed' };
  }
  if (result.status === 'timeout') {
    const unfinished = result.tests.filter((test) => test.status === 'unfinished').map((test) => test.name);
    return { ...base, kind: 'timeout', timeoutSeconds, failing, unfinished };
  }
  return { ...base, kind: result.gate === 1 ? 'gate1Failed' : 'gate2Failed', failing };
}

export interface QaOutcome {
  startedAt: string;
  branch: string | null;
  branchWarning: boolean;
  timeoutSeconds: number;
  result: QaResult;
  /** The player's diff against the stage commit, kept for the review when QA passes. */
  playerDiff?: string | null;
}

/** Records a finished QA run: passing moves the card to Code Review, anything else back to In Progress. */
export function recordQaResult(state: GameState, ticket: number, outcome: QaOutcome, ctx: RuleContext): GameState {
  const current = requireActive(state, ticket);
  requireColumn(current, 'inQa');
  const attempt: QaAttempt = {
    id: ctx.id(),
    number: current.attempts.length + 1,
    startedAt: outcome.startedAt,
    finishedAt: ctx.now,
    branch: outcome.branch,
    branchWarning: outcome.branchWarning,
    timeoutSeconds: outcome.timeoutSeconds,
    result: outcome.result,
  };
  const comment = commentForResult(outcome.result, attempt.id, outcome.timeoutSeconds, ctx);
  const passed = outcome.result.status === 'passed';
  const reason = passed ? 'qaPassed' : outcome.result.status === 'timeout' ? 'qaTimeout' : 'qaFailed';
  return move(state, ticket, passed ? 'codeReview' : 'inProgress', ctx, 'system', reason, (item) => ({
    ...item,
    qaStartedAt: null,
    attempts: [...item.attempts, attempt],
    comments: [...item.comments, comment],
    playerDiff: passed ? (outcome.playerDiff ?? item.playerDiff) : item.playerDiff,
  }));
}

/** QA could not run (for example Docker stopped). Not the player's fault, so not an attempt. */
export function recordQaError(state: GameState, ticket: number, detail: string, ctx: RuleContext): GameState {
  const current = requireActive(state, ticket);
  requireColumn(current, 'inQa');
  const comment: QaComment = { id: ctx.id(), at: ctx.now, kind: 'error', detail };
  return move(state, ticket, 'inProgress', ctx, 'system', 'qaError', (item) => ({
    ...item,
    qaStartedAt: null,
    comments: [...item.comments, comment],
  }));
}

/** On startup: a card still in In QA means the app closed during QA. Not counted as an attempt. */
export function recoverInterruptedQa(state: GameState, ctx: RuleContext): GameState {
  let next = state;
  for (const ticket of state.tickets.filter((item) => item.status === 'inQa')) {
    const comment: QaComment = { id: ctx.id(), at: ctx.now, kind: 'interrupted' };
    next = move(next, ticket.ticket, 'inProgress', ctx, 'system', 'qaInterrupted', (item) => ({
      ...item,
      qaStartedAt: null,
      comments: [...item.comments, comment],
    }));
  }
  return next;
}

export function revealHint(state: GameState, ticket: number, totalHints: number, ctx: RuleContext): GameState {
  const current = requireActive(state, ticket);
  requireColumn(current, 'inProgress');
  if (current.hintsRevealed >= totalHints) {
    throw new GameRuleError('noMoreHints');
  }
  return updateTicket(state, ticket, (item) => ({
    ...item,
    hintsRevealed: item.hintsRevealed + 1,
    conversation: [
      ...item.conversation,
      { at: ctx.now, from: 'player', kind: 'question' },
      { at: ctx.now, from: 'senior', kind: 'hint', hintIndex: item.hintsRevealed },
    ],
  }));
}

export function revealSolution(state: GameState, ticket: number, totalHints: number, ctx: RuleContext): GameState {
  const current = requireActive(state, ticket);
  requireColumn(current, 'inProgress');
  if (current.hintsRevealed < totalHints) {
    throw new GameRuleError('hintsRemaining');
  }
  if (current.solutionRevealed) {
    throw new GameRuleError('solutionAlreadyRevealed');
  }
  return updateTicket(state, ticket, (item) => ({
    ...item,
    solutionRevealed: true,
    conversation: [
      ...item.conversation,
      { at: ctx.now, from: 'player', kind: 'solutionRequest' },
      { at: ctx.now, from: 'senior', kind: 'solution' },
    ],
  }));
}

export function acceptReview(state: GameState, ticket: number, ctx: RuleContext): GameState {
  const current = requireActive(state, ticket);
  requireColumn(current, 'codeReview');
  const next = move(state, ticket, 'done', ctx, 'player', 'reviewAccepted', (item) => ({
    ...item,
    reviewAcceptedAt: ctx.now,
  }));
  return withTrackCompletions(next, ctx);
}

/** The tracks whose every ticket is Done; fullstack when both front and back are. A track without tickets never completes. */
export function completedTracks(state: GameState): TrackChoice[] {
  const counts = state.tracks;
  if (!counts) {
    return [];
  }
  const done = (track: Track) =>
    counts[track] > 0 && state.tickets.filter((item) => item.track === track && item.status === 'done').length >= counts[track];
  const tracks: TrackChoice[] = TRACKS.filter(done);
  return tracks.length === TRACKS.length ? [...tracks, 'fullstack'] : tracks;
}

/**
 * One message per newly completed track: the first is the project's completion, the next ones
 * are track completions. Each track gets its message once.
 */
function withTrackCompletions(state: GameState, ctx: RuleContext): GameState {
  const announced = new Set(state.inbox.filter((m) => m.kind === 'completion' || m.kind === 'trackCompletion').map((m) => m.track));
  let inbox = state.inbox;
  for (const track of completedTracks(state).filter((item) => !announced.has(item))) {
    const kind = inbox.some((m) => m.kind === 'completion') ? 'trackCompletion' : 'completion';
    inbox = [...inbox, { id: ctx.id(), kind, track, at: ctx.now, read: false }];
  }
  return inbox === state.inbox ? state : { ...state, inbox };
}

/**
 * A newer publication changed the number of tickets per track: the queues follow it, never below
 * the tickets already unlocked, and a track that is now complete gets its message.
 */
export function setTrackCounts(state: GameState, counts: TrackCounts, ctx: RuleContext): GameState {
  const unlockedIn = (track: Track) => state.tickets.filter((item) => item.track === track).length;
  const tracks = { front: Math.max(counts.front, unlockedIn('front')), back: Math.max(counts.back, unlockedIn('back')) };
  return withTrackCompletions({ ...state, tracks }, ctx);
}

/**
 * Rafaela's onboarding opens on its own until it is finished. A game that already has an unlocked
 * ticket (a save from before the onboarding existed) counts as seen: the player is not interrupted.
 */
export function onboardingDue(state: GameState): boolean {
  return !state.onboardingSeen && state.tickets.length === 0;
}

export function finishOnboarding(state: GameState): GameState {
  return { ...state, onboardingSeen: true };
}

export function markInboxRead(state: GameState, id: string): GameState {
  return { ...state, inbox: state.inbox.map((message) => (message.id === id ? { ...message, read: true } : message)) };
}

// ---------------------------------------------------------------------------
// Projects

/** The Projects screen shows once any project of the game is done (it got its completion message). */
export function projectsUnlocked(state: GameState): boolean {
  const done = (inbox: InboxMessage[]) => inbox.some((message) => message.kind === 'completion');
  return done(state.inbox) || Object.values(state.otherProjects).some((progress) => done(progress.inbox));
}

/**
 * Starts a switch from the active project to another one: the active project's progress is kept
 * in otherProjects, the other one's comes back (or starts from zero), and projectSwitch records
 * that Docker still has to be cleaned. Only with no ticket open and no review checked out.
 */
export function beginSwitch(state: GameState, from: string, to: string, ctx: RuleContext): GameState {
  if (state.projectSwitch) {
    throw new GameRuleError('switchInProgress', `A switch to ${state.projectSwitch.to} is not finished`);
  }
  if (from === to) {
    throw new GameRuleError('sameProject', `${to} is already the active project`);
  }
  if (!canTakeTicket(state) || state.reviewSession) {
    throw new GameRuleError('ticketNotDone', 'Finish the open ticket and close its review first');
  }
  const kept: ProjectProgress = { createdAt: state.createdAt, tracks: state.tracks, tickets: state.tickets, activity: state.activity, inbox: state.inbox };
  const { [to]: back, ...others } = state.otherProjects;
  const progress: ProjectProgress = back ?? {
    createdAt: ctx.now,
    tracks: null,
    tickets: [],
    activity: [],
    inbox: [{ id: ctx.id(), kind: 'welcome', at: ctx.now, read: false }],
  };
  return {
    ...state,
    project: to,
    otherProjects: { ...others, [from]: kept },
    projectSwitch: { from, to, phase: 'cleaning', startedAt: ctx.now },
    createdAt: progress.createdAt,
    tracks: progress.tracks,
    tickets: progress.tickets,
    activity: progress.activity,
    inbox: progress.inbox,
    currentTicket: progress.tickets.at(-1)?.ticket ?? null,
    reviewSession: null,
  };
}

/** Docker has nothing left of the other projects: the switch is done. */
export function finishSwitch(state: GameState): GameState {
  return { ...state, projectSwitch: null };
}
