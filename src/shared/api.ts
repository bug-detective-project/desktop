/** The typed contract between the renderer and the main process (exposed by the preload script). */
import type { Column, GameState, Language, Settings, Track, TrackChoice } from './types.ts';

export type EngineState = 'notInstalled' | 'notRunning' | 'starting' | 'running';
export type CheckId = 'docker' | 'wsl' | 'vscode' | 'devcontainers';

export interface CheckResult {
  id: CheckId;
  status: 'ok' | 'missing' | 'warning' | 'pending';
  reason?: string;
  detail?: string;
  /** Version of the tool, when it could be read (Docker Desktop or engine, VS Code, the extension, WSL). */
  version?: string;
}

export interface PrerequisiteReport {
  checks: CheckResult[];
  allOk: boolean;
  dockerState: EngineState;
}

export type EnvironmentItemId = 'workspaceImage' | 'qaImage' | 'projectDependencies';

export interface EnvironmentItem {
  id: EnvironmentItemId;
  ready: boolean;
}

export interface EnvironmentReport {
  items: EnvironmentItem[];
  ready: boolean;
}

export type DiskItemId = 'workspaceVolume' | 'workspaceImage' | 'qaImage' | 'qaCache';

export interface DiskUsageItem {
  id: DiskItemId;
  /** Size on disk, or null when the image or volume does not exist yet. */
  bytes: number | null;
}

export type BusyTask =
  | 'unlocking'
  | 'starting'
  | 'installing'
  | 'qa'
  | 'exporting'
  | 'restoring'
  | 'startingDocker'
  | 'openingReview'
  | 'closingReview'
  | 'cleaningDocker'
  | 'removingDocker'
  | 'solvingBug'
  | null;

/** Opening VS Code waits for every task except QA (it tests its own copy of the code, so the player may look meanwhile). */
export function blocksVSCode(busy: BusyTask): boolean {
  return busy !== null && busy !== 'qa';
}

/** leftovers: QA leftovers and images of older app versions; everything: all the app created, the player's code too. */
export type DockerCleanupScope = 'leftovers' | 'everything';

/** What a Docker cleanup removed, and what it could not remove (with Docker's reason). */
export interface DockerCleanup {
  removed: number;
  failed: { kind: 'container' | 'volume' | 'image'; name: string; reason: string }[];
  /** "everything" only: the volume with the player's code is still there, so the game was kept. */
  workspaceKept?: boolean;
}

/**
 * What happened when the app brought the player's code back after a review, told in ticket terms:
 * editsSaved: changes made while the review was checked out were saved separately;
 * workKept: the temporary commit of their work was no longer the branch tip, so it stays as a commit.
 */
export interface ReviewNotice {
  ticket: number;
  kind: 'editsSaved' | 'workKept';
}

/**
 * The stored comparison of a ticket that passed QA, as unified diffs (git diff -M). "solutions" goes
 * from the approved snapshot (old side, the left pane) to the reference (new side, the right pane);
 * "baseline" from the stage the ticket started from to the approved snapshot.
 */
export interface ReviewComparison {
  solutions: string;
  solutionsIgnoringWhitespace: string;
  baseline: string;
  baselineIgnoringWhitespace: string;
}

export interface StoryMessage {
  subject: string;
  body: string;
}

/** The project's part of the story (story.<lang>.json on its qa branch): the client, the project and the manager's messages. */
export interface ProjectStory {
  client: { name: string; about: string; contacts: string; reporters: { name: string; role: string }[] };
  project: { name: string; about: string; stack: string };
  messages: {
    welcome: StoryMessage;
    /** By ticket id (front-1, back-1, …). */
    assignments: Record<string, StoryMessage>;
    /** The project is done (the first track completed). */
    completion: StoryMessage;
    /** A later track completed; {{track}} names it. */
    trackCompletion: StoryMessage;
  };
}

/** A track's queue: its next ticket (or null when it is finished), and how many of its tickets are Done. */
export interface TrackQueue {
  next: { id: string; track: Track; title: Record<Language, string> } | null;
  done: number;
  total: number;
}

export interface Snapshot {
  state: GameState;
  /** The number the next unlocked ticket gets, or null when none can be taken now (one open, or none left). */
  nextTicket: number | null;
  /** Each track's queue, or null until the project's content is downloaded. */
  queues: Record<TrackChoice, TrackQueue> | null;
  titles: Record<number, Record<Language, string>>;
  hintsTotal: Record<number, number>;
  busy: BusyTask;
  dockerState: EngineState | null;
  prerequisites: PrerequisiteReport | null;
  environment: EnvironmentReport | null;
  /** Output of the running install or QA, most recent last. */
  log: string[];
  reviewNotice: ReviewNotice | null;
  contentSource: string;
  /** The project's story per language, or null until the project's content is downloaded. */
  projectStory: Record<Language, ProjectStory> | null;
  appVersion: string;
  versions: { electron: string; node: string; chrome: string };
  /** Development only: the board shows "Solve bug" (BUGDETECTIVE_DEV_SOLVE_BUG_BUTTON). */
  devSolveBug: boolean;
  /** Rafaela's onboarding opens on its own on the Dashboard (the first time, it cannot be skipped). */
  onboardingDue: boolean;
  /** Development only: the onboarding shows "Skip onboarding" (BUGDETECTIVE_DEV_SKIP_ONBOARDING_BUTTON). */
  devSkipOnboarding: boolean;
}

export interface TicketContent {
  ticket: number;
  ticketMarkdown: string;
  hints: string[];
  hintsTotal: number;
  solutionMarkdown: string | null;
  reviewMarkdown: string | null;
  /** reference.patch: shown with the solution, and in Code Review. */
  referencePatch: string | null;
  playerDiff: string | null;
}

export interface WorkspaceStatus {
  ports: { client: number; api: number } | null;
  devServerUp: boolean;
  branch: string | null;
}

export interface ApiError {
  code: string;
  message: string;
}

export type Envelope<T> = { ok: true; value: T } | { ok: false; error: ApiError };

export interface BugDetectiveApi {
  snapshot(): Promise<Snapshot>;
  onSnapshot(listener: (snapshot: Snapshot) => void): () => void;

  checkPrerequisites(): Promise<PrerequisiteReport>;
  startDocker(): Promise<EngineState>;
  installDevContainers(): Promise<PrerequisiteReport>;

  refreshEnvironment(): Promise<EnvironmentReport>;
  installEnvironment(): Promise<EnvironmentReport>;
  /** Disk space used by the game's images and volumes. Needs Docker running; can take a few seconds. */
  diskUsage(): Promise<DiskUsageItem[]>;

  nextAssignment(track: TrackChoice): Promise<void>;
  move(ticket: number, to: Column): Promise<void>;
  askSenior(ticket: number): Promise<void>;
  revealSolution(ticket: number): Promise<void>;
  acceptReview(ticket: number): Promise<void>;
  markInboxRead(id: string): Promise<void>;
  /** Rafaela's onboarding was finished: it no longer opens on its own. */
  finishOnboarding(): Promise<void>;

  /** The stored comparison of a ticket in Code Review or Done; works without Docker. */
  reviewComparison(ticket: number): Promise<ReviewComparison>;
  /** Saves the player's work, checks out the ticket's review and opens VS Code on it. */
  openReview(ticket: number): Promise<void>;
  /** Brings the player's code back ("Back to my code"). */
  closeReview(): Promise<void>;
  dismissReviewNotice(): Promise<void>;

  ticketContent(ticket: number, language: Language): Promise<TicketContent>;
  workspaceStatus(): Promise<WorkspaceStatus>;
  openVSCode(): Promise<void>;
  openAppInBrowser(): Promise<void>;
  startDevServer(): Promise<void>;
  stopDevServer(): Promise<void>;
  /** Development only: applies the reference fix of the ticket in progress to the player's code. */
  solveBug(ticket: number): Promise<void>;
  openExternal(link: ExternalLink): Promise<void>;

  updateSettings(settings: Partial<Settings>): Promise<void>;
  exportProgress(): Promise<{ saved: boolean; path?: string }>;
  /** Picks a save file and returns what it contains, so the player can confirm before overwriting. */
  inspectSave(): Promise<{ token: string; summary: SaveSummary } | null>;
  restoreProgress(token: string): Promise<void>;
  /** The player cancelled the restore: the main process stops keeping the save. */
  discardSave(token: string): Promise<void>;
  /** Starts over; the workspace's branches from this game are archived on the next unlock. */
  newGame(): Promise<void>;
  /** Removes QA leftovers and images of older versions; the player's work stays. */
  cleanDockerLeftovers(): Promise<DockerCleanup>;
  /** Removes everything the app created in Docker, the player's code included, and starts a new game. */
  removeDockerData(): Promise<DockerCleanup>;
}

export interface SaveSummary {
  fileName: string;
  createdAt: string;
  appVersion: string;
  ticketsDone: number;
  currentTicket: number | null;
  /** True when the current game has progress that the restore would overwrite. */
  overwritesProgress: boolean;
}

/** The only external pages the app opens (besides the workspace app on 127.0.0.1). */
export const EXTERNAL_LINKS = {
  dockerDesktop: 'https://docs.docker.com/desktop/setup/install/windows-install/',
  wsl: 'https://learn.microsoft.com/windows/wsl/install',
  vscode: 'https://code.visualstudio.com/download',
  devContainers: 'https://marketplace.visualstudio.com/items?itemName=ms-vscode-remote.remote-containers',
} as const;

export type ExternalLink = keyof typeof EXTERNAL_LINKS;
