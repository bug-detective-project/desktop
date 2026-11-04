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

/** desktop/catalog.local.json (development only): another projects catalog, and per-project overrides. */
export interface LocalCatalog {
  catalog?: { github: string; branch?: string } | { file: string };
  projects?: Record<string, { qaDir: string } | { qaRef: string }>;
}

/** Settings → Development (development only): the settings file and the catalog it gives. */
export interface DevCatalogView {
  file: string;
  settings: LocalCatalog;
  /** Why the file could not be read or written; the settings shown are then the defaults. */
  error: string | null;
  /** BUGDETECTIVE_CATALOG_FILE is set and wins over the file: the settings cannot be applied. */
  testFile: boolean;
  /** The catalog source in use: official, github owner/repo@branch or file <path>. */
  inUse: string;
  /** The chosen catalog was never downloaded: the app uses the copy bundled at build time. */
  fallback: boolean;
  /** The projects of the catalog in use and where each one's content comes from. */
  projects: { id: string; qaRef: string; source: string }[];
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
  | 'switchingProject'
  | 'applyingCatalog'
  | 'rebuilding'
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

/** A project on the Projects screen. details is null until its content is downloaded. */
export interface ProjectCard {
  id: string;
  active: boolean;
  /** At least one ticket of it was unlocked in this game. */
  played: boolean;
  details: {
    name: Record<Language, string>;
    about: Record<Language, string>;
    /** The client the project is built for (the story's client name). */
    client: Record<Language, string>;
    /** The project's technologies (the manifest's project.stack), or null when it has none. */
    stack: { frontend?: string; backend?: string; database?: string } | null;
    /** What the player practices (the story's project.skills); empty when it has none. */
    skills: Record<Language, string[]>;
    difficulty: ProjectDifficulty | null;
    counts: Record<Track, number>;
  } | null;
  progress: Record<Track, { done: number; total: number }> | null;
  /** appTooOld: the project needs a newer Bug Detective (its minAppVersion, or a newer content format). */
  unavailable: 'appTooOld' | null;
}

export type ProjectDifficulty = 'beginner' | 'intermediate' | 'advanced';

export interface Snapshot {
  state: GameState;
  /** The number the next unlocked ticket gets, or null when none can be taken now (one open, or none left). */
  nextTicket: number | null;
  /** Each track's queue, or null until the project's content is downloaded. */
  queues: Record<TrackChoice, TrackQueue> | null;
  /** The Projects screen is available: some project of this game is done. */
  projectsUnlocked: boolean;
  /** Every project of content/projects.json, or null in a single-project game. */
  projects: ProjectCard[] | null;
  /** The active project needs a newer Bug Detective: the game goes on with the downloaded content. */
  projectNeedsUpdate: boolean;
  /** A new game cannot start: the catalog's starter project needs a newer Bug Detective. */
  starterNeedsUpdate: boolean;
  /** While a project switch is pending: what Docker still holds of other projects. */
  projectSwitchLeft: { kind: 'container' | 'volume' | 'image'; name: string }[] | null;
  titles: Record<number, Record<Language, string>>;
  hintsTotal: Record<number, number>;
  busy: BusyTask;
  /** Tickets were unlocked but the workspace holds no repository (its volume was removed outside the game): the code can be recreated. */
  workspaceLost: boolean;
  /** The last `npm run db:reset` failed: the app's data may be the previous ticket's until a retry succeeds. */
  dbResetFailed: boolean;
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
  /** Development only: Settings → Development; null in the installed app. */
  devCatalog: DevCatalogView | null;
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
  /** Removes the active project from Docker and makes another one active (needs internet and Docker). */
  switchProject(project: string): Promise<void>;
  /** Retries the Docker cleanup of a pending project switch. */
  finishProjectSwitch(): Promise<void>;
  /** Downloads what the Projects screen shows of the other projects. */
  loadProjects(): Promise<void>;
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
  /** Recreates the code of every unlocked ticket in a workspace whose repository was lost; the progress stays. */
  rebuildWorkspace(): Promise<void>;
  /** Runs `npm run db:reset` again after a failed reset (the Dashboard's "Try again"). */
  retryDatabaseReset(): Promise<void>;
  /** The diagnostics text (versions, environment, the recent log with paths redacted) for "Copy diagnostics". */
  diagnostics(): Promise<string>;
  /** Opens the folder of the log files in the system's file manager. */
  openLogsFolder(): Promise<void>;
  /** Starts over; the workspace's branches from this game are archived on the next unlock. */
  newGame(): Promise<void>;
  /** Removes QA leftovers and images of older versions; the player's work stays. */
  cleanDockerLeftovers(): Promise<DockerCleanup>;
  /** Removes everything the app created in Docker, the player's code included, and starts a new game. */
  removeDockerData(): Promise<DockerCleanup>;
  /** Development only: writes catalog.local.json and reloads the projects catalog (from the next ticket). */
  applyDevCatalog(settings: LocalCatalog): Promise<void>;
  /** Development only: picks a catalog file or a project's qa folder; null when cancelled. */
  chooseDevPath(kind: 'file' | 'folder'): Promise<string | null>;
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
  proxyHelp: 'https://github.com/bug-detective-project/desktop#networks-with-a-proxy',
  /** "Send feedback": the repository's discussions, until a feedback form exists. */
  feedback: 'https://github.com/bug-detective-project/desktop/discussions',
} as const;

export type ExternalLink = keyof typeof EXTERNAL_LINKS;
