/** Types shared by the main process, the preload bridge and the renderer. */

export const HINTS_PER_TICKET = 3;
export const DEFAULT_QA_TIMEOUT_SECONDS = 180;
export const MIN_QA_TIMEOUT_SECONDS = 60;
export const MAX_QA_TIMEOUT_SECONDS = 1800;

/** The workspace branch where the player works on a ticket. */

/** The career tracks with tickets of their own; fullstack combines them. */
export const TRACKS = ['front', 'back'] as const;
export type Track = (typeof TRACKS)[number];
export const TRACK_CHOICES = ['front', 'back', 'fullstack'] as const;
export type TrackChoice = (typeof TRACK_CHOICES)[number];
export type TrackCounts = Record<Track, number>;

export const COLUMNS = ['todo', 'inProgress', 'inQa', 'codeReview', 'done'] as const;
export type Column = (typeof COLUMNS)[number];

export const LANGUAGES = ['en', 'pt'] as const;
export type Language = (typeof LANGUAGES)[number];

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

// ---------------------------------------------------------------------------
// QA results, as written by the SupportDesk QA CLI with --json

export type QaTestStatus = 'passed' | 'failed' | 'skipped' | 'unfinished';

export interface QaTestRecord {
  name: string;
  status: QaTestStatus;
  error?: string;
}

export interface QaResult {
  ticket: number;
  gate: 1 | 2;
  status: 'passed' | 'failed' | 'timeout';
  message: string;
  tests: QaTestRecord[];
  durationMs: number;
}

export interface QaAttempt {
  id: string;
  /** 1-based attempt number for this ticket. Interrupted runs and infrastructure errors are not attempts. */
  number: number;
  startedAt: string;
  finishedAt: string;
  /** Branch checked out in the workspace when QA started, or null for a detached HEAD. */
  branch: string | null;
  branchWarning: boolean;
  timeoutSeconds: number;
  result: QaResult;
}

export type QaCommentKind =
  | 'gate1Failed'
  | 'gate2Failed'
  | 'timeout'
  | 'passed'
  | 'interrupted'
  | 'error'
  | 'branchWarning';

/** A QA comment is stored as data and rendered with the templates of the current language. */
export interface QaComment {
  id: string;
  at: string;
  kind: QaCommentKind;
  attemptId?: string;
  failing?: { name: string; error?: string }[];
  unfinished?: string[];
  timeoutSeconds?: number;
  /** Technical detail for an infrastructure error (not translated). */
  detail?: string;
  /** For branch warnings: the branch that was checked out instead. */
  branch?: string | null;
}

export type ChatKind = 'question' | 'hint' | 'solutionRequest' | 'solution';

export interface ChatEntry {
  at: string;
  from: 'player' | 'senior';
  kind: ChatKind;
  /** 0-based hint index for kind "hint". */
  hintIndex?: number;
}

export interface TicketState {
  /** The order in which the player unlocked the ticket (1, 2, 3…); never reused in a game. */
  ticket: number;
  /** The ticket's id in the project manifest, for example front-1. */
  id: string;
  track: Track;
  /** The version of the project manifest the ticket was unlocked from. */
  manifestVersion: string;
  status: Column;
  unlockedAt: string;
  /** Commit of the imported stage snapshot in the workspace repository. */
  stageCommit: string | null;
  attempts: QaAttempt[];
  comments: QaComment[];
  hintsRevealed: number;
  solutionRevealed: boolean;
  reviewAcceptedAt: string | null;
  /** Set while QA is running, so an interrupted run can be detected on the next start. */
  qaStartedAt: string | null;
  /** The player's diff against the stage commit, captured when QA passed. */
  playerDiff: string | null;
  conversation: ChatEntry[];
}

export interface ActivityEntry {
  ticket: number;
  from: Column | null;
  to: Column;
  at: string;
  actor: 'player' | 'system';
  reason?: 'unlocked' | 'started' | 'submitted' | 'qaPassed' | 'qaFailed' | 'qaTimeout' | 'qaInterrupted' | 'qaError' | 'reviewAccepted';
}

export type InboxKind = 'welcome' | 'assignment' | 'completion' | 'trackCompletion';

export interface InboxMessage {
  id: string;
  kind: InboxKind;
  ticket?: number;
  /** completion (the project) and trackCompletion: the track that was completed. */
  track?: TrackChoice;
  at: string;
  read: boolean;
}

export interface Settings {
  language: Language;
  qaTimeoutSeconds: number;
  theme: Theme;
}

/** The last successful export. Kept in the state, so a save also knows the export it came from. */
export interface LastExport {
  at: string;
  /** Full path of the .bdsave file, as the operating system's save dialog returned it. */
  path: string;
}

/**
 * A review checked out in the workspace. Written before every step of the checkout and the return,
 * so an interrupted switch is finished or rolled back on the next start.
 */
export interface ReviewSession {
  ticket: number;
  /** saving: the temporary commit may exist; switching: the review may be checked out; open; returning. */
  phase: 'saving' | 'switching' | 'open' | 'returning';
  startedAt: string;
  /** Where the player was: their branch (null for a detached HEAD), HEAD, index and excludes file. */
  returnPoint: { branch: string | null; head: string; indexTree: string; excludesFile: string | null };
  /** The temporary commit with the player's uncommitted work, or null when there was none. */
  wipCommit: string | null;
}

export const SCHEMA_VERSION = 5;

export interface GameState {
  schemaVersion: typeof SCHEMA_VERSION;
  createdAt: string;
  /** The active ticket (the last unlocked one), or null before the first assignment. */
  currentTicket: number | null;
  /** How many tickets each track has, from the manifest of the last unlock; null before the first one. */
  tracks: TrackCounts | null;
  tickets: TicketState[];
  /** Append-only. */
  activity: ActivityEntry[];
  inbox: InboxMessage[];
  settings: Settings;
  /** Added after version 2 shipped; optional, so older state files stay valid. */
  lastExport?: LastExport | null;
  /** The review checked out in the workspace, or null when the player's code is checked out. */
  reviewSession: ReviewSession | null;
  /** Rafaela's onboarding was finished (or skipped in development); optional, so older state files stay valid. */
  onboardingSeen?: boolean;
}

/**
 * Whether the work is protected by an export: 'none' before the first ticket (nothing to lose),
 * 'outdated' when the game changed after the last export (or was never exported).
 */
export function backupStatus(state: GameState): 'none' | 'current' | 'outdated' {
  if (state.tickets.length === 0) {
    return 'none';
  }
  const since = state.lastExport?.at;
  if (!since) {
    return 'outdated';
  }
  const changed =
    state.activity.some((entry) => entry.at > since) ||
    state.tickets.some((ticket) => ticket.conversation.some((entry) => entry.at > since) || ticket.attempts.some((attempt) => attempt.finishedAt > since));
  return changed ? 'outdated' : 'current';
}
