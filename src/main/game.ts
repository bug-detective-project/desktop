/**
 * The game controller: applies the Kanban rules to the saved state and drives the runtime.
 * Independent of Electron, so it can be tested with plain Node.
 */
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  BusyTask,
  DiskUsageItem,
  DockerCleanup,
  EngineState,
  EnvironmentReport,
  PrerequisiteReport,
  ReviewComparison,
  ReviewNotice,
  SaveSummary,
  Snapshot,
  ProjectCard,
  TicketContent,
  TrackQueue,
  WorkspaceStatus,
  DevCatalogView,
  LocalCatalog,
} from '../shared/api.ts';
import { blocksVSCode } from '../shared/api.ts';
import * as rules from '../shared/kanban.ts';
import type { RuleContext } from '../shared/kanban.ts';
import { HINTS_PER_TICKET, LANGUAGES, MAX_QA_TIMEOUT_SECONDS, MIN_QA_TIMEOUT_SECONDS } from '../shared/types.ts';
import type { Column, GameState, Language, ReviewSession, Settings, Track, TrackChoice, TrackCounts } from '../shared/types.ts';
import type { GameRuntime } from './runtime.ts';
import { createSave, readSave } from './services/backup.ts';
import { IncompletePublicationError, TicketNotPublishedError, UnsupportedFormatError, appSupports, compareVersions, countsOf, fileText, parseReviewConfig, projectContentOf, qaToolFiles, writeZip } from '@bug-detective/catalog/contract';
import type { ArchiveFile, ProjectFiles, ReviewConfig } from '@bug-detective/catalog/contract';
import type { ValidatedSave } from './services/backup.ts';
import { FirstDownloadError } from './services/content/cache.ts';
import type { ContentSource, FetchedTicket, ProjectContent } from './services/content/source.ts';
import type { CleanupTarget } from './services/cleanup.ts';
import type { ResolvedProject } from './services/catalog.ts';
import type { PackageStore } from './services/content/store.ts';
import { writeFileAtomic } from './services/content/store.ts';
import { DockerUnavailableError } from './services/docker.ts';
import { excludeMatcher, excludePathspecs, excludesFileContent } from './services/review/config.ts';
import { WIP_MESSAGE, editsStamp, readOnlySettings, reviewMessages } from './services/review/review.ts';
import type { ReviewMeta, ReviewStore } from './services/review/store.ts';
import type { StateStore } from './services/state.ts';
import { playerBranch } from './services/workspace.ts';

export class GameError extends Error {
  readonly code: string;

  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
  }
}

/** Content errors the player can act on get their own code; anything else is shown as it is. */
export function contentError(error: unknown): unknown {
  if (error instanceof IncompletePublicationError) {
    return new GameError('incompletePublication', error.message);
  }
  if (error instanceof FirstDownloadError) {
    return new GameError('contentNeedsInternet', error.message);
  }
  if (error instanceof UnsupportedFormatError) {
    return new GameError('appTooOld', error.message);
  }
  return error;
}

export interface GameOptions {
  store: StateStore;
  packages: PackageStore;
  reviews: ReviewStore;
  /** Tests only: a review configuration instead of the one in the project's content. */
  review?: ReviewConfig;
  content: ContentSource;
  runtime: GameRuntime;
  appVersion: string;
  versions: Snapshot['versions'];
  /** Development only: allows "Solve bug" (never set by the packaged app). */
  devSolveBug?: boolean;
  /** Development only: the onboarding can be skipped (never set by the packaged app). */
  devSkipOnboarding?: boolean;
  /** Development only: the Projects screen shows from the start (never set by the packaged app). */
  devShowProjects?: boolean;
  /** False keeps the onboarding from opening on its own (the e2e tests, unless they test it). */
  autoOnboarding?: boolean;
  /** Every game project and how to reach each one's content and data (without it, the game has one project). */
  projects?: GameProjects;
  /** Development only: Settings → Development reads and writes catalog.local.json (never set by the packaged app). */
  devCatalog?: DevCatalogOptions;
  /** Called after every change, with the new snapshot. */
  onChange?: (snapshot: Snapshot) => void;
  clock?: () => Date;
}

/** catalog.local.json for Settings → Development (see services/catalog.ts). */
export interface DevCatalogOptions {
  file: string;
  /** BUGDETECTIVE_CATALOG_FILE is set: it wins over the file. */
  testFile: boolean;
  read(): Promise<{ settings: LocalCatalog; error: string | null }>;
  /** Throws for invalid settings, keeping the file. */
  write(settings: LocalCatalog): Promise<void>;
  /** Points the catalog at the settings' source and overrides. */
  reconfigure(settings: LocalCatalog): void;
}

/** The projects catalog (see services/catalog.ts), with each project's content source and data folders. */
export interface GameProjects {
  catalog: { current(): Promise<ResolvedProject[]>; refresh(): Promise<boolean>; describe?(): string; usingFallback?(): boolean };
  /** The content source of a project; minVersion is the oldest manifest version it may accept. */
  content(project: ResolvedProject, minVersion: string | null): ContentSource;
  packages(id: string): PackageStore;
  reviews(id: string): ReviewStore;
}

const LOG_LINES = 300;

export class Game {
  private state!: GameState;
  private readonly options: GameOptions;
  private busy: BusyTask = null;
  private dockerState: EngineState | null = null;
  private prerequisites: PrerequisiteReport | null = null;
  private environment: EnvironmentReport | null = null;
  private log: string[] = [];
  private titles: Snapshot['titles'] = {};
  private hintsTotal: Record<number, number> = {};
  private qaRun: Promise<void> | null = null;
  /** The save chosen to restore, waiting for the player to confirm. One at a time: a save can be hundreds of MB. */
  private pendingSave: (ValidatedSave & { fileName: string; token: string }) | null = null;
  private reviewNotice: ReviewNotice | null = null;
  /** A review was still checked out when the app started: bring the player's code back once Docker answers. */
  private recoverReview = false;
  private returning: Promise<void> | null = null;
  /** The last answer of workspaceStatus. */
  private lastWorkspaceStatus: WorkspaceStatus | null = null;
  /** The last queued state change (see commit). */
  private commits: Promise<void> = Promise.resolve();
  /** The project's review configuration and story, once its content is available. */
  private projectFiles: ProjectFiles | null = null;
  /** The project's content (manifest and qa files), once it is available. */
  private content: ProjectContent | null = null;
  /** The first download of the project's content, started at init when nothing was downloaded. */
  private contentDownload: Promise<void> = Promise.resolve();

  /** The active project's content source and data folders (they change with a project switch). */
  private source: ContentSource;
  /** The catalog entry the source was made from: a different one makes a new source. */
  private sourceKey: string | null = null;
  private packages: PackageStore;
  private reviews: ReviewStore;
  /** What a downloaded project shows on the Projects screen, by id. */
  private projectInfo = new Map<string, ProjectContent>();
  /** The projects catalog in use (refreshed when a ticket is taken and when Projects opens). */
  private catalog: ResolvedProject[] = [];
  /** Projects whose content format is newer than this app understands, by id. */
  private newerFormat = new Set<string>();
  /** What Docker still holds of other projects, after the last cleanup. */
  private leftovers: CleanupTarget[] = [];
  /** Development only: catalog.local.json as last read or written. */
  private devSettings: { settings: LocalCatalog; error: string | null } = { settings: {}, error: null };

  constructor(options: GameOptions) {
    this.options = options;
    this.source = options.content;
    this.packages = options.packages;
    this.reviews = options.reviews;
  }

  /** The active project's id: the state's, or the catalog's starter before a game is pinned to it. */
  private activeProject(): string | null {
    return this.state.project ?? this.starterId();
  }

  private starterId(): string | null {
    return this.catalog.find((item) => item.starter)?.id ?? null;
  }

  /** Every project the catalog lists or this game played, except the active one. */
  private otherProjectIds(): string[] {
    const active = this.activeProject();
    const ids = [...this.catalog.map((item) => item.id), ...Object.keys(this.state.projectSources), ...Object.keys(this.state.otherProjects)];
    return [...new Set(ids)].filter((id) => id !== active);
  }

  /** Where a project's content comes from: the catalog in use, else the source this game last used (a project that left the catalog). */
  private sourceOf(id: string): ResolvedProject | null {
    const listed = this.catalog.find((item) => item.id === id);
    if (listed) {
      return listed;
    }
    const known = this.state.projectSources[id];
    return known ? { id, repository: known.repository, qaRef: known.qaRef, starter: false, official: true } : null;
  }

  private projectEntry(id: string): ResolvedProject {
    const entry = this.sourceOf(id);
    if (!entry) {
      throw new GameError('unknownProject', `${id} is not in the projects catalog`);
    }
    return entry;
  }

  /** The project needs a newer app: its catalog entry says so, or its content uses a newer format. */
  private needsUpdate(id: string): boolean {
    const entry = this.sourceOf(id);
    return this.newerFormat.has(id) || (entry !== null && !appSupports(entry, this.options.appVersion));
  }

  /** Remembers a project whose content needs a newer app, then rethrows. */
  private noteFormat(id: string, error: unknown): never {
    if (error instanceof UnsupportedFormatError) {
      this.newerFormat.add(id);
      this.emit();
    }
    throw error;
  }

  /** A project's content source, with its version floor when its source is the official one. */
  private contentOf(id: string): ContentSource {
    const entry = this.projectEntry(id);
    const floor = entry.official ? (this.state.projectSources[id]?.minVersion ?? null) : null;
    return this.options.projects!.content(entry, floor);
  }

  /** The state with a project's source recorded, and its floor raised to an accepted official version. */
  private withSource(state: GameState, id: string, accepted: string | null): GameState {
    const entry = this.sourceOf(id);
    if (!entry || !this.options.projects) {
      return state;
    }
    const before = state.projectSources[id]?.minVersion ?? null;
    const raised = entry.official && accepted !== null && (before === null || compareVersions(accepted, before) > 0) ? accepted : before;
    const next = { repository: entry.repository, qaRef: entry.qaRef, minVersion: raised };
    const current = state.projectSources[id];
    if (current && current.repository === next.repository && current.qaRef === next.qaRef && current.minVersion === next.minVersion) {
      return state;
    }
    return { ...state, projectSources: { ...state.projectSources, [id]: next } };
  }

  /** Reads the catalog in use (the cache or the bundled fallback). */
  private async loadCatalog(): Promise<void> {
    if (this.options.projects) {
      this.catalog = await this.options.projects.catalog.current();
    }
  }

  /** Downloads the catalog again (failures keep the cache), then uses it. */
  async refreshCatalog(): Promise<void> {
    if (!this.options.projects) {
      return;
    }
    await this.options.projects.catalog.refresh().catch(() => false);
    await this.loadCatalog().catch(() => {});
    if (this.busy === null && this.followCatalog()) {
      await this.loadContent();
    }
    this.emit();
  }

  private devCatalogView(): DevCatalogView | null {
    const dev = this.options.devCatalog;
    if (!dev) {
      return null;
    }
    return {
      file: dev.file,
      ...this.devSettings,
      testFile: dev.testFile,
      inUse: this.options.projects?.catalog.describe?.() ?? 'official',
      fallback: this.options.projects?.catalog.usingFallback?.() ?? false,
      projects: this.catalog.map((item) => ({ id: item.id, qaRef: item.qaRef, source: item.qaDir !== undefined ? `local: ${item.qaDir}` : `github: ${item.repository} (${item.qaRef})` })),
    };
  }

  /**
   * Development only: writes catalog.local.json, points the catalog at it and reloads it. The
   * active project follows from the next ticket (followCatalog); the open ticket keeps its code.
   */
  async applyDevCatalog(settings: LocalCatalog): Promise<void> {
    const dev = this.options.devCatalog;
    if (!dev) {
      throw new GameError('notAllowed', 'The development settings exist only in development');
    }
    if (dev.testFile) {
      throw new GameError('notAllowed', 'BUGDETECTIVE_CATALOG_FILE decides the catalog');
    }
    this.requireNoSwitch();
    await this.exclusive('applyingCatalog', async () => {
      try {
        await dev.write(settings);
      } catch (error) {
        this.devSettings = { ...this.devSettings, error: (error as Error).message };
        throw new GameError('invalidCatalogSettings', (error as Error).message);
      }
      this.devSettings = await dev.read();
      dev.reconfigure(this.devSettings.settings);
    });
    // After the exclusive task: the active project follows the new catalog only when nothing runs.
    await this.refreshCatalog();
  }

  private activeProjectNeedsUpdate(): boolean {
    const active = this.activeProject();
    return this.options.projects !== undefined && active !== null && this.needsUpdate(active);
  }

  /** A game belongs to one project from its start: a catalog that later names another starter does not move it. */
  private async pinProject(): Promise<void> {
    const starter = this.starterId();
    if (this.options.projects && this.state.project === null && starter) {
      await this.commit((state) => ({ ...state, project: starter }));
    }
  }

  private entryKey(id: string): string | null {
    const entry = this.sourceOf(id);
    return entry && JSON.stringify([entry.repository, entry.qaRef, entry.qaDir ?? null, entry.official]);
  }

  /**
   * Follows the catalog when the active project's entry changed (it moved to another repository or
   * ref, or the development settings changed): its content comes from the new source from the next
   * ticket. Only when nothing runs, so a ticket being unlocked keeps the source it started with.
   * Returns whether the source changed.
   */
  private followCatalog(): boolean {
    const active = this.activeProject();
    if (!this.options.projects || !active || this.state.projectSwitch || this.entryKey(active) === this.sourceKey) {
      return false;
    }
    this.source = this.contentOf(active);
    this.sourceKey = this.entryKey(active);
    this.content = null;
    this.projectFiles = null;
    return true;
  }

  /** Points the content source, the data folders and new Docker resources at a project. */
  private useProject(id: string): void {
    const projects = this.options.projects;
    if (!projects) {
      return;
    }
    this.source = this.contentOf(id);
    this.sourceKey = this.entryKey(id);
    this.packages = projects.packages(id);
    this.reviews = projects.reviews(id);
    this.options.runtime.setProject(id);
    this.content = null;
    this.projectFiles = null;
  }

  /**
   * Removes every Docker resource of the other projects. When nothing is left and a switch was
   * waiting for it, the switch is done. Returns what is left.
   */
  private async cleanOtherProjects(): Promise<CleanupTarget[]> {
    if (!this.options.projects) {
      return [];
    }
    this.leftovers = await this.options.runtime.removeProjects(this.otherProjectIds());
    const pending = this.state.projectSwitch;
    if (pending && this.leftovers.length === 0) {
      await this.contentOf(pending.from).forget?.();
      await this.commit((state) => rules.finishSwitch(state));
    }
    this.emit();
    return this.leftovers;
  }

  private requireNoSwitch(): void {
    if (this.state.projectSwitch) {
      throw new GameError('switchIncomplete', `The switch to ${this.state.projectSwitch.to} is not finished`);
    }
  }

  private ctx(): RuleContext {
    return { now: (this.options.clock?.() ?? new Date()).toISOString(), id: () => randomUUID() };
  }

  /** Loads the saved game and recovers a QA run interrupted by a crash or a closed app. */
  async init(language: Language = 'en'): Promise<void> {
    const { state } = await this.options.store.load(this.ctx(), language);
    const recovered = rules.recoverInterruptedQa(state, this.ctx());
    this.state = recovered;
    if (recovered !== state) {
      await this.options.store.save(recovered);
    }
    this.recoverReview = recovered.reviewSession !== null;
    if (this.options.devCatalog) {
      this.devSettings = await this.options.devCatalog.read();
    }
    await this.loadCatalog();
    await this.pinProject();
    const active = this.activeProject();
    if (active) {
      this.useProject(active);
    }
    await this.loadTicketMeta();
    // Only the active project may stay in Docker: finish a pending switch, remove what others left.
    if (this.options.projects) {
      await this.cleanOtherProjects().catch(() => {});
    }
    await this.loadContent();
  }

  /** Uses the content already downloaded, otherwise starts downloading it. */
  private async loadContent(): Promise<void> {
    const content = await this.source.current().catch(() => null);
    if (content) {
      await this.useContent(content);
    } else {
      // Small (the qa branch and the code of each ticket): the story is there before the setup.
      this.contentDownload = this.source.prepare().then(
        (downloaded) => this.useContent(downloaded),
        () => {},
      );
    }
  }

  /** Resolves when the content download started by init has finished (or failed). */
  contentLoaded(): Promise<void> {
    return this.contentDownload;
  }

  /** The project's content is available: its QA tool, review configuration and story. Records its source and version. */
  private async useContent(content: ProjectContent): Promise<void> {
    this.projectFiles = projectContentOf(content.qaFiles);
    this.content = content;
    this.options.runtime.setQaTool(qaToolFiles(content.qaFiles));
    // The workspace folder is named after the project and its git identity after the project's
    // name: both come from the manifest, with or without a catalog.
    this.options.runtime.setProject(content.manifest.project.id, content.manifest.project.name);
    this.emit();
    const active = this.activeProject();
    if (active && this.withSource(this.state, active, content.manifest.version) !== this.state) {
      await this.commit((state) => this.withSource(state, active, content.manifest.version));
    }
  }

  /** The tickets per track: the downloaded manifest's, else the last unlock's. */
  private counts(): TrackCounts | null {
    return this.content ? countsOf(this.content.manifest) : this.state.tracks;
  }

  private titleOf(id: string): Record<Language, string> {
    const read = (language: Language) => {
      const file = this.content?.qaFiles.find((item) => item.path === `tickets/${id}/ticket.${language}.md`);
      return (file && /^#\s+(.+)$/m.exec(fileText(file))?.[1]?.trim()) || id;
    };
    return { en: read('en'), pt: read('pt') };
  }

  private queues(): Snapshot['queues'] {
    const counts = this.counts();
    if (!counts) {
      return null;
    }
    const done = (track?: Track) => this.state.tickets.filter((item) => item.status === 'done' && (!track || item.track === track)).length;
    const queue = (choice: TrackChoice): TrackQueue => {
      const id = rules.nextIdFor(this.state, counts, choice);
      const track = choice === 'fullstack' ? undefined : choice;
      return {
        next: id ? { id, track: id.split('-')[0] as Track, title: this.titleOf(id) } : null,
        done: done(track),
        total: track ? counts[track] : counts.front + counts.back,
      };
    };
    return { front: queue('front'), back: queue('back'), fullstack: queue('fullstack') };
  }

  /** The number of the next ticket, when one can be taken now. */
  private nextTicket(): number | null {
    const counts = this.counts();
    const left = counts !== null && rules.nextIdFor(this.state, counts, 'fullstack') !== null;
    return left && rules.canTakeTicket(this.state) ? this.state.tickets.length + 1 : null;
  }

  private get review(): ReviewConfig {
    return this.options.review ?? this.projectFiles?.review ?? parseReviewConfig();
  }

  get current(): GameState {
    return this.state;
  }

  snapshot(): Snapshot {
    return {
      state: this.state,
      nextTicket: this.nextTicket(),
      queues: this.queues(),
      projectsUnlocked: rules.projectsUnlocked(this.state) || (this.options.devShowProjects ?? false),
      projects: this.projectCards(),
      projectNeedsUpdate: this.activeProjectNeedsUpdate(),
      // Nothing played yet: the game cannot start at all.
      starterNeedsUpdate: this.state.tickets.length === 0 && Object.keys(this.state.otherProjects).length === 0 && this.activeProjectNeedsUpdate(),
      projectSwitchLeft: this.state.projectSwitch ? this.leftovers : null,
      titles: this.titles,
      hintsTotal: this.hintsTotal,
      busy: this.busy,
      dockerState: this.dockerState,
      prerequisites: this.prerequisites,
      environment: this.environment,
      log: this.log,
      reviewNotice: this.reviewNotice,
      contentSource: `${this.source.kind}: ${this.source.describe()}`,
      projectStory: this.projectFiles?.story ?? null,
      appVersion: this.options.appVersion,
      versions: this.options.versions,
      devSolveBug: this.options.devSolveBug ?? false,
      onboardingDue: (this.options.autoOnboarding ?? true) && rules.onboardingDue(this.state),
      devSkipOnboarding: this.options.devSkipOnboarding ?? false,
      devCatalog: this.devCatalogView(),
    };
  }

  private emit(): void {
    this.options.onChange?.(this.snapshot());
  }

  private appendLog(line: string): void {
    this.log = [...this.log, line].slice(-LOG_LINES);
    this.emit();
  }

  /**
   * Applies a change and saves it. Changes run one at a time, each on the state the previous one
   * left, so two changes that overlap (a QA result and a settings change) never undo each other.
   */
  private commit(change: (state: GameState, ctx: RuleContext) => GameState): Promise<void> {
    const run = this.commits.then(async () => {
      const next = this.apply(change);
      await this.options.store.save(next);
      this.state = next;
      this.emit();
    });
    this.commits = run.catch(() => {});
    return run;
  }

  /** Applies a rule; GameRuleErrors become GameErrors with the same code. */
  private apply(change: (state: GameState, ctx: RuleContext) => GameState): GameState {
    try {
      return change(this.state, this.ctx());
    } catch (error) {
      if (error instanceof rules.GameRuleError) {
        throw new GameError(error.code, error.message);
      }
      throw error;
    }
  }

  private async exclusive<T>(task: Exclude<BusyTask, null>, action: () => Promise<T>): Promise<T> {
    if (this.busy) {
      throw new GameError('busy', `Busy: ${this.busy}`);
    }
    this.busy = task;
    this.log = [];
    this.emit();
    try {
      return await action();
    } finally {
      this.busy = null;
      this.emit();
    }
  }

  private async loadTicketMeta(): Promise<void> {
    for (const ticket of this.state.tickets) {
      const titles = {} as Record<Language, string>;
      for (const language of LANGUAGES) {
        const markdown = (await this.packages.readText(ticket.ticket, `ticket.${language}.md`)) ?? '';
        titles[language] = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? `Ticket ${ticket.ticket}`;
      }
      this.titles[ticket.ticket] = titles;
      const hints = await this.packages.readText(ticket.ticket, 'hints.en.json');
      this.hintsTotal[ticket.ticket] = hints ? (JSON.parse(hints) as { hints: string[] }).hints.length : HINTS_PER_TICKET;
    }
  }

  // -------------------------------------------------------------------------
  // Docker and prerequisites

  setDockerState(state: EngineState): void {
    if (state !== this.dockerState) {
      this.dockerState = state;
      this.emit();
    }
  }

  async refreshDockerState(): Promise<EngineState> {
    const state = await this.options.runtime.dockerState().catch((): EngineState => 'notRunning');
    this.setDockerState(state);
    if (state === 'running' && this.recoverReview && !this.busy) {
      this.recoverReview = false;
      void this.returnToPlayerCode().catch((error: unknown) => this.appendLog(`» Could not restore your code: ${(error as Error).message}`));
    }
    return state;
  }

  private async requireDocker(): Promise<void> {
    if ((await this.refreshDockerState()) !== 'running') {
      throw new GameError('dockerUnavailable', 'Docker is not running');
    }
  }

  /** Removes QA containers left behind by a crash or a closed app. */
  async cleanupLeftovers(): Promise<void> {
    if ((await this.refreshDockerState()) === 'running') {
      await this.options.runtime.cleanupQaLeftovers().catch(() => {});
    }
  }

  async checkPrerequisites(): Promise<PrerequisiteReport> {
    this.prerequisites = await this.options.runtime.checkPrerequisites();
    this.dockerState = this.prerequisites.dockerState;
    this.emit();
    return this.prerequisites;
  }

  async startDocker(): Promise<EngineState> {
    return this.exclusive('startingDocker', async () => {
      const state = await this.options.runtime.startDocker((polled) => this.setDockerState(polled));
      this.setDockerState(state);
      await this.checkPrerequisites();
      return state;
    });
  }

  async installDevContainers(): Promise<PrerequisiteReport> {
    await this.options.runtime.installDevContainers();
    return this.checkPrerequisites();
  }

  async refreshEnvironment(): Promise<EnvironmentReport> {
    await this.requireDocker();
    this.environment = await this.options.runtime.environment();
    this.emit();
    return this.environment;
  }

  async diskUsage(): Promise<DiskUsageItem[]> {
    await this.requireDocker();
    return this.options.runtime.diskUsage();
  }

  async installEnvironment(): Promise<EnvironmentReport> {
    this.requireNoSwitch();
    await this.requireDocker();
    await this.exclusive('installing', async () => {
      const left = await this.cleanOtherProjects();
      if (left.length > 0) {
        throw new GameError('otherProjectsLeft', `Docker still has resources of another project: ${left.map((item) => item.name).join(', ')}`);
      }
      this.appendLog(`» Downloading the project from ${this.source.describe()}`);
      try {
        await this.useContent(await this.source.prepare());
      } catch (error) {
        throw contentError(error);
      }
      await this.options.runtime.installEnvironment((line) => this.appendLog(line));
    });
    return this.refreshEnvironment();
  }

  // -------------------------------------------------------------------------
  // Projects

  /**
   * Switches to another project: its content is downloaded first (nothing changes without the
   * internet), then the switch is recorded, the old project leaves Docker, and the new one becomes
   * active. A cleanup that leaves something behind keeps the switch pending (switchIncomplete):
   * finishProjectSwitch, or the next start, completes it.
   */
  async switchProject(to: string): Promise<void> {
    const projects = this.options.projects;
    if (!projects || !this.catalog.some((item) => item.id === to)) {
      throw new GameError('unknownProject', `${to} is not in the projects catalog`);
    }
    if (this.needsUpdate(to)) {
      throw new GameError('appTooOld', `${to} needs a newer version of Bug Detective`);
    }
    const from = this.activeProject()!;
    this.apply((state, ctx) => {
      rules.beginSwitch(state, from, to, ctx);
      return state;
    });
    await this.requireDocker();
    await this.exclusive('switchingProject', async () => {
      this.appendLog(`» Downloading ${to}`);
      let content: ProjectContent;
      try {
        content = await this.contentOf(to)
          .prepare()
          .catch((error: unknown) => this.noteFormat(to, error));
      } catch (error) {
        throw contentError(error);
      }
      await this.commit((state, ctx) => rules.beginSwitch(this.withSource(state, to, null), from, to, ctx));
      this.useProject(to);
      await this.useContent(content);
      this.titles = {};
      this.hintsTotal = {};
      await this.loadTicketMeta();
      this.appendLog(`» Removing ${from} from Docker`);
      const left = await this.cleanOtherProjects();
      if (left.length > 0) {
        throw new GameError('switchIncomplete', `Docker still has: ${left.map((item) => item.name).join(', ')}`);
      }
      this.appendLog(`» ${to} is the active project`);
    });
    await this.refreshEnvironment().catch(() => {});
  }

  /** Retries the cleanup of a pending switch (the Dashboard's "Finish the switch"). */
  async finishProjectSwitch(): Promise<void> {
    await this.requireDocker();
    await this.exclusive('switchingProject', async () => {
      const left = await this.cleanOtherProjects();
      if (left.length > 0) {
        throw new GameError('switchIncomplete', `Docker still has: ${left.map((item) => item.name).join(', ')}`);
      }
    });
  }

  /** Downloads what the Projects screen shows of every other project (online only; failures are skipped). */
  async loadProjects(): Promise<void> {
    await this.refreshCatalog();
    for (const id of this.otherProjectIds()) {
      const content = await this.contentOf(id)
        .prepare()
        .catch((error: unknown) => {
          if (error instanceof UnsupportedFormatError) this.newerFormat.add(id);
          return null;
        });
      if (content) {
        this.projectInfo.set(id, content);
      }
    }
    this.emit();
  }

  private projectCards(): Snapshot['projects'] {
    const projects = this.options.projects;
    if (!projects) {
      return null;
    }
    const active = this.activeProject();
    // The catalog's projects, without hidden ones nobody played here, then played projects that left the catalog.
    const played = (id: string) => id === active || this.state.otherProjects[id] !== undefined || this.state.projectSources[id] !== undefined;
    const ids = [
      ...this.catalog.filter((item) => !item.hidden || played(item.id)).map((item) => item.id),
      ...[...Object.keys(this.state.otherProjects), active ?? ''].filter((id) => id && !this.catalog.some((item) => item.id === id)),
    ];
    return [...new Set(ids)].map((id): ProjectCard => {
      const item = { id };
      const content = item.id === active ? this.content : (this.projectInfo.get(item.id) ?? null);
      let details: ProjectCard['details'] = null;
      if (content) {
        const { story } = projectContentOf(content.qaFiles);
        const pick = (field: 'name' | 'about') => ({ en: story.en.project[field], pt: story.pt.project[field] });
        details = {
          name: pick('name'),
          about: pick('about'),
          client: { en: story.en.client.name, pt: story.pt.client.name },
          stack: content.manifest.project.stack ?? null,
          skills: { en: story.en.project.skills ?? [], pt: story.pt.project.skills ?? [] },
          difficulty: content.manifest.project.difficulty ?? null,
          counts: countsOf(content.manifest),
        };
      }
      const progress = item.id === active ? { tickets: this.state.tickets, tracks: this.state.tracks } : (this.state.otherProjects[item.id] ?? null);
      const done = (track: Track) => progress?.tickets.filter((ticket) => ticket.track === track && ticket.status === 'done').length ?? 0;
      return {
        id: item.id,
        active: item.id === active,
        played: progress !== null && progress.tickets.length > 0,
        details,
        progress: progress?.tracks ? { front: { done: done('front'), total: progress.tracks.front }, back: { done: done('back'), total: progress.tracks.back } } : null,
        unavailable: this.needsUpdate(item.id) ? 'appTooOld' : null,
      };
    });
  }

  // -------------------------------------------------------------------------
  // Assignments

  /**
   * Unlocks the next ticket of a track (fullstack alternates). Download and verification happen
   * first; the workspace is only touched once everything is verified, so a failed download can
   * simply be retried.
   */
  async nextAssignment(choice: TrackChoice = 'front'): Promise<void> {
    this.requireNoSwitch();
    if (!rules.canTakeTicket(this.state)) {
      throw new GameError('ticketNotDone');
    }
    await this.requireDocker();
    // A newer catalog applies from here on; the ticket never waits for it.
    void this.refreshCatalog();
    await this.exclusive('unlocking', async () => {
      await this.beforePlayerCode();
      this.followCatalog();
      if (!this.content) {
        try {
          await this.useContent(await this.source.prepare());
        } catch (error) {
          throw contentError(error);
        }
      }
      const id = rules.nextIdFor(this.state, this.counts()!, choice);
      if (!id) {
        throw new GameError('noMoreTickets');
      }
      const ticket = this.state.tickets.length + 1;
      this.appendLog(`» Fetching ${id} from ${this.source.describe()}`);
      let fetched: FetchedTicket;
      try {
        fetched = await this.source.fetchTicket(id);
      } catch (error) {
        if (error instanceof TicketNotPublishedError) {
          // A newer publication has fewer tickets in that track: its queue ends, nothing else changes.
          const content = await this.source.current().catch(() => null);
          if (content) {
            await this.useContent(content);
          }
          await this.commit((state, ctx) => rules.setTrackCounts(state, error.counts, ctx));
          throw new GameError('noMoreTickets', error.message);
        }
        throw contentError(error);
      }
      this.appendLog(`» Verified ${fetched.entry.id} (${fetched.codeFiles.length} files and the ticket package, SHA-256)`);
      await this.packages.save(ticket, writeZip(fetched.packageFiles));
      const content = await this.source.current().catch(() => null);
      if (content) {
        await this.useContent(content);
      }
      // The volume outlives the saved game: work from another game is archived, never reused.
      const archived = await this.options.runtime.claimWorkspace(this.state.createdAt);
      if (archived > 0) {
        this.appendLog(`» Kept the code of a previous game in the workspace history (${archived} ticket(s))`);
      }
      const commit = await this.options.runtime.importStage(ticket, fetched.codeFiles, fetched.entry.commitMessage);
      await this.options.runtime.claimWorkspace(this.state.createdAt);
      this.appendLog(`» Imported as commit ${commit.slice(0, 12)}`);
      await this.options.runtime.checkoutPlayerBranch(ticket);
      this.appendLog(`» Workspace ready for ticket ${ticket} (${fetched.entry.id})`);
      await this.options.runtime.resetDatabase().catch(() => {});
      const info = { id: fetched.entry.id, track: fetched.entry.track, commit, manifestVersion: fetched.manifestVersion, counts: fetched.counts };
      await this.commit((state, ctx) => rules.unlockTicket(state, ticket, info, ctx));
      await this.loadTicketMeta();
    });
    await this.refreshEnvironment().catch(() => {});
  }

  async move(ticket: number, to: Column): Promise<void> {
    if (to === 'inQa') {
      return this.submitToQa(ticket);
    }
    if (to === 'inProgress') {
      return this.startTicket(ticket);
    }
    await this.commit((state, ctx) => rules.playerMove(state, ticket, to, ctx));
  }

  /**
   * To Do → In Progress happens exactly once per ticket (cards never go back to To Do), so the
   * player always starts from the clean stage: whatever is left in the workspace (from an earlier
   * playthrough, an interrupted run or edits made before starting) is discarded, and the database
   * is reseeded. Coming back from QA does not pass through here, so work in progress is kept.
   */
  private async startTicket(ticket: number): Promise<void> {
    // Validate the move before touching anything.
    this.apply((state, ctx) => rules.playerMove(state, ticket, 'inProgress', ctx));
    await this.requireDocker();
    await this.exclusive('starting', async () => {
      await this.beforePlayerCode();
      const discarded = await this.options.runtime.resetToStage(ticket);
      if (discarded.changes > 0 || discarded.commits > 0) {
        this.appendLog(`» Workspace reset to stage ${ticket}: discarded ${discarded.changes} changed file(s) and ${discarded.commits} commit(s)`);
      }
      await this.options.runtime.resetDatabase().catch(() => {});
      await this.commit((state, ctx) => rules.playerMove(state, ticket, 'inProgress', ctx));
    });
  }

  /** Moving to In QA: checks the environment, moves the card and runs QA in the background. */
  private async submitToQa(ticket: number): Promise<void> {
    // Validate the move before any slow check, so forbidden moves fail fast.
    this.apply((state, ctx) => rules.playerMove(state, ticket, 'inQa', ctx));
    if (this.busy) {
      throw new GameError('busy', `Busy: ${this.busy}`);
    }
    // Reserved before the slow checks, so no other task starts in between; released if QA never starts.
    this.busy = 'qa';
    this.log = [];
    this.emit();
    let startedAt: string;
    try {
      await this.requireDocker();
      await this.beforePlayerCode();
      const environment = await this.refreshEnvironment();
      if (!environment.ready) {
        throw new GameError('environmentNotReady');
      }
      startedAt = this.ctx().now;
      await this.commit((state, ctx) => rules.playerMove(state, ticket, 'inQa', ctx));
    } catch (error) {
      this.busy = null;
      this.emit();
      throw error;
    }
    this.qaRun = this.runQa(ticket, startedAt).finally(() => {
      this.busy = null;
      this.qaRun = null;
      this.emit();
    });
  }

  /** Resolves when the QA run started by the last move to In QA has finished (for tests). */
  async waitForQa(): Promise<void> {
    await this.qaRun;
  }

  private async runQa(ticket: number, startedAt: string): Promise<void> {
    const { runtime } = this.options;
    const { packages } = this;
    const timeoutSeconds = this.state.settings.qaTimeoutSeconds;
    try {
      const branch = await runtime.currentBranch();
      const branchWarning = branch !== playerBranch(ticket);
      if (branchWarning) {
        await this.commit((state, ctx) => rules.addBranchWarning(state, ticket, branch, ctx));
      }
      const result = await runtime.runQa({
        ticket,
        language: this.state.settings.language,
        timeoutSeconds,
        packageDir: packages.dir(ticket),
        onLine: (line) => this.appendLog(line),
      });
      // A pass is recorded only with its approved snapshot; if that cannot be saved, QA did not complete.
      const playerDiff = result.status === 'passed' ? await this.captureApproval(ticket) : null;
      await this.commit((state, ctx) => rules.recordQaResult(state, ticket, { startedAt, branch, branchWarning, timeoutSeconds, result, playerDiff }, ctx));
    } catch (error) {
      const detail = error instanceof DockerUnavailableError ? 'Docker stopped while QA was running.' : (error as Error).message;
      await this.commit((state, ctx) => rules.recordQaError(state, ticket, detail.slice(0, 4000), ctx));
      await this.refreshDockerState();
    }
  }

  async askSenior(ticket: number): Promise<void> {
    await this.commit((state, ctx) => rules.revealHint(state, ticket, this.hintsTotal[ticket] ?? HINTS_PER_TICKET, ctx));
  }

  async revealSolution(ticket: number): Promise<void> {
    await this.commit((state, ctx) => rules.revealSolution(state, ticket, this.hintsTotal[ticket] ?? HINTS_PER_TICKET, ctx));
  }

  /** Accepting uses only the approved snapshot; with Docker stopped, the player's code comes back later. */
  async acceptReview(ticket: number): Promise<void> {
    this.apply((state, ctx) => rules.acceptReview(state, ticket, ctx));
    if (this.state.reviewSession && (await this.refreshDockerState()) === 'running') {
      await this.exclusive('closingReview', () => this.returnToPlayerCode());
    }
    await this.commit((state, ctx) => rules.acceptReview(state, ticket, ctx));
  }

  /**
   * Starts over with a new game. The workspace's branches are archived on the next unlock (the
   * repository belongs to the old game id), and downloaded packages are removed.
   */
  async newGame(): Promise<void> {
    if (this.busy || this.qaRun) {
      throw new GameError('busy');
    }
    if (this.state.reviewSession) {
      await this.requireDocker();
      await this.exclusive('closingReview', () => this.returnToPlayerCode());
    }
    await this.startOver();
  }

  /** A fresh game that keeps the preferences; downloaded packages and reviews are removed. */
  private async startOver(): Promise<void> {
    // The repository goes on with the next game: what the old game's code configured in it goes.
    await this.options.runtime.sanitizeWorkspace().catch((error: Error) => this.appendLog(`» Workspace not sanitized: ${error.message}`));
    const projects = this.options.projects;
    for (const id of projects ? this.catalog.map((item) => item.id) : []) {
      await projects!.packages(id).clear();
      await projects!.reviews(id).clear();
    }
    await this.packages.clear();
    await this.reviews.clear();
    this.titles = {};
    this.hintsTotal = {};
    // Nothing of the old game is recovered or reported in the new one.
    this.recoverReview = false;
    this.reviewNotice = null;
    await this.commit((state, ctx) => {
      const { language, theme, qaTimeoutSeconds } = state.settings;
      const fresh = rules.createInitialState(ctx, language);
      return { ...fresh, settings: { ...fresh.settings, theme, qaTimeoutSeconds } };
    });
    // A new game starts with the catalog's starter project, and only it may stay in Docker.
    await this.loadCatalog().catch(() => {});
    await this.pinProject();
    const starter = this.activeProject();
    if (starter && this.options.projects) {
      this.useProject(starter);
      const content = await this.source.current().catch(() => null);
      if (content) {
        await this.useContent(content);
      }
      await this.cleanOtherProjects().catch(() => {});
    }
  }

  /** "Clean up leftovers": QA leftovers and images of older versions. The player's work stays. */
  async cleanDockerLeftovers(): Promise<DockerCleanup> {
    return this.exclusive('cleaningDocker', async () => {
      await this.requireDocker();
      const result = await this.options.runtime.cleanDocker('leftovers');
      // Other projects never stay in Docker either; what cannot be removed is reported as failed.
      const left = await this.cleanOtherProjects();
      for (const item of left) {
        result.failed.push({ kind: item.kind, name: item.name, reason: 'belongs to another project' });
      }
      await this.refreshEnvironment().catch(() => {});
      return result;
    });
  }

  /**
   * "Remove everything from Docker": every container, volume and image of the app, the player's
   * code included, then a new game (a game without its code cannot go on; a backup can be restored).
   * The game is kept when the volume with the code could not be removed. A checked-out review is not
   * returned first: its branch goes away with the rest. Everything runs inside one exclusive task,
   * so no other action (nor the start-up review recovery) runs in between.
   */
  async removeDockerData(): Promise<DockerCleanup> {
    return this.exclusive('removingDocker', async () => {
      await this.requireDocker();
      // A recovery started just before (Docker came back) finishes first: it works in the container about to go.
      await this.returning?.catch(() => {});
      const result = await this.options.runtime.cleanDocker('everything');
      if (!result.workspaceKept) {
        await this.startOver();
      }
      await this.refreshEnvironment().catch(() => {});
      return result;
    });
  }

  async markInboxRead(id: string): Promise<void> {
    await this.commit((state) => rules.markInboxRead(state, id));
  }

  async finishOnboarding(): Promise<void> {
    await this.commit((state) => rules.finishOnboarding(state));
  }

  async updateSettings(settings: Partial<Settings>): Promise<void> {
    await this.commit((state) => {
      const next = { ...state.settings, ...settings };
      next.qaTimeoutSeconds = Math.min(MAX_QA_TIMEOUT_SECONDS, Math.max(MIN_QA_TIMEOUT_SECONDS, Math.round(next.qaTimeoutSeconds)));
      return { ...state, settings: next };
    });
  }

  /** Ticket texts and what the player has unlocked so far: hints, solution, review. */
  async ticketContent(ticket: number, language: Language): Promise<TicketContent> {
    const current = rules.findTicket(this.state, ticket);
    if (!current) {
      throw new GameError('noSuchTicket');
    }
    const read = (file: string) => this.packages.readText(ticket, file);
    const hintsJson = await read(`hints.${language}.json`);
    const allHints = hintsJson ? (JSON.parse(hintsJson) as { hints: string[] }).hints : [];
    const inReview = current.status === 'codeReview' || current.status === 'done';
    const showReference = inReview || current.solutionRevealed;
    return {
      ticket,
      ticketMarkdown: (await read(`ticket.${language}.md`)) ?? '',
      hints: allHints.slice(0, current.hintsRevealed),
      hintsTotal: allHints.length,
      solutionMarkdown: current.solutionRevealed ? await read(`solution.${language}.md`) : null,
      reviewMarkdown: inReview ? await read(`review.${language}.md`) : null,
      referencePatch: showReference ? await read('reference.patch') : null,
      playerDiff: current.playerDiff,
    };
  }

  /**
   * Ports, dev server and branch, polled by the UI. Read-only; while a task other than QA changes the
   * workspace, the last answer stands and Docker is not asked.
   */
  async workspaceStatus(): Promise<WorkspaceStatus> {
    if (this.busy && this.busy !== 'qa' && this.lastWorkspaceStatus) {
      return this.lastWorkspaceStatus;
    }
    await this.requireDocker();
    this.lastWorkspaceStatus = await this.options.runtime.workspaceStatus();
    return this.lastWorkspaceStatus;
  }

  async openVSCode(): Promise<void> {
    await this.requireDocker();
    if (blocksVSCode(this.busy)) {
      throw new GameError('busy', `Busy: ${this.busy}`);
    }
    if (this.state.reviewSession) {
      await this.exclusive('closingReview', () => this.returnToPlayerCode());
    }
    await this.options.runtime.openVSCode();
  }

  async startDevServer(): Promise<void> {
    await this.requireDocker();
    await this.options.runtime.startDevServer();
  }

  async stopDevServer(): Promise<void> {
    await this.requireDocker();
    await this.options.runtime.stopDevServer();
  }

  /** Development only: puts the ticket's reference fix into the player's code, so the rest of the flow can be tested quickly. */
  async solveBug(ticket: number): Promise<void> {
    const current = this.state.tickets.find((item) => item.ticket === ticket);
    if (!this.options.devSolveBug || ticket !== this.state.currentTicket || current?.status !== 'inProgress') {
      throw new GameError('solveBugNotAllowed');
    }
    await this.requireDocker();
    await this.exclusive('solvingBug', async () => {
      await this.beforePlayerCode();
      const patch = await this.packages.readText(ticket, 'reference.patch');
      if (!patch) {
        throw new GameError('solveBugNotAllowed', `Ticket ${ticket} has no reference patch`);
      }
      this.appendLog(`» Solving ticket ${ticket} with its reference patch (development)`);
      await this.options.runtime.solveBug(ticket, patch);
    });
  }

  /** The URL of the player's app on the published port. */
  async appUrl(): Promise<string> {
    await this.requireDocker();
    const ports = await this.options.runtime.workspacePorts();
    if (!ports?.client) {
      throw new GameError('workspaceNotRunning');
    }
    return `http://127.0.0.1:${ports.client}/`;
  }

  // -------------------------------------------------------------------------
  // Code review: approved snapshot, review branch, automatic checkout and return

  private get excludes(): string[] {
    return excludePathspecs(this.review);
  }

  /**
   * After a QA pass: stores the approved snapshot (the files QA tested, after the excludes) and the
   * reference, creates the tag and the review branch, and computes the comparison. Returns the
   * player's diff against the stage.
   */
  private async captureApproval(ticket: number): Promise<string> {
    const { runtime } = this.options;
    const { packages, reviews } = this;
    this.appendLog('» Saving the approved solution for the code review');
    const excluded = excludeMatcher(this.review);
    const snapshot = (await runtime.testedFiles()).filter((file) => !excluded(file.path));
    const reference = await runtime.referenceFiles(ticket, (await packages.readText(ticket, 'reference.patch')) ?? '');
    const meta = { ticket, approvedAt: this.ctx().now, language: this.state.settings.language };
    const commits = await this.buildReviewBranch(meta, snapshot, reference);
    const comparison = await runtime.reviewComparison(ticket, commits, this.excludes);
    // Only the diff is kept: the ticket's commit plus this diff gives the snapshot back.
    const snapshotDiff = await runtime.commitDiff(`refs/tags/stage-${ticket}`, commits.approved);
    // The ticket is still In QA: an earlier pass that failed to record may be replaced.
    await reviews.save({ meta: { ...meta, commits, comparison }, snapshotDiff }, { replace: true });
    return comparison.baseline;
  }

  private buildReviewBranch(meta: Pick<ReviewMeta, 'ticket' | 'approvedAt' | 'language'>, snapshot: ArchiveFile[], reference: ArchiveFile[]) {
    const projectSettings = reference.find((file) => file.path === '.vscode/settings.json');
    return this.options.runtime.buildReview({
      ticket: meta.ticket,
      date: meta.approvedAt,
      messages: reviewMessages(meta.ticket),
      snapshot,
      reference,
      settings: readOnlySettings(projectSettings ? fileText(projectSettings) : null),
      excludes: this.excludes,
    });
  }

  /** Recreates the tag and the review branch from the stored data when they are missing or moved. */
  private async ensureReviewBranch(ticket: number): Promise<void> {
    const stored = await this.reviews.load(ticket);
    if (!stored) {
      throw new GameError('noReview');
    }
    const refs = await this.options.runtime.reviewRefs(ticket);
    if (refs.branch === stored.meta.commits.snapshot && refs.tag === stored.meta.commits.approved) {
      return;
    }
    this.appendLog('» Rebuilding the review from the saved solution');
    // Both trees come back from the ticket's commit, which only the repository of this project has.
    let snapshot: ArchiveFile[];
    let reference: ArchiveFile[];
    try {
      snapshot = await this.options.runtime.referenceFiles(ticket, stored.snapshotDiff);
      reference = await this.options.runtime.referenceFiles(ticket, (await this.packages.readText(ticket, 'reference.patch')) ?? '');
    } catch (error) {
      throw new GameError('reviewUnavailable', `The code of ticket ${ticket} is not in this workspace: ${(error as Error).message}`);
    }
    const commits = await this.buildReviewBranch(stored.meta, snapshot, reference);
    if (JSON.stringify(commits) !== JSON.stringify(stored.meta.commits)) {
      await this.reviews.save({ ...stored, meta: { ...stored.meta, commits } });
    }
  }

  private requireReviewable(ticket: number): void {
    const current = rules.findTicket(this.state, ticket);
    if (!current || (current.status !== 'codeReview' && current.status !== 'done') || !this.reviews.has(ticket)) {
      throw new GameError('noReview');
    }
  }

  /** The stored comparison; needs no Docker. */
  async reviewComparison(ticket: number): Promise<ReviewComparison> {
    this.requireReviewable(ticket);
    return (await this.reviews.comparison(ticket))!;
  }

  private async saveSession(session: ReviewSession | null): Promise<void> {
    await this.commit((state) => ({ ...state, reviewSession: session }));
  }

  /**
   * "Open Review in VS Code": saves the player's work as a temporary commit, checks out the review
   * and opens VS Code. Any failure brings the player's code back before the error is shown.
   */
  async openReview(ticket: number): Promise<void> {
    this.requireReviewable(ticket);
    await this.requireDocker();
    await this.exclusive('openingReview', async () => {
      const open = this.state.reviewSession;
      if (open && (open.ticket !== ticket || open.phase !== 'open')) {
        await this.returnToPlayerCode();
      }
      if (!this.state.reviewSession) {
        this.appendLog('» Preparing the review');
        await this.ensureReviewBranch(ticket);
        await this.checkOutReview(ticket);
      }
      this.appendLog('» Opening VS Code');
      try {
        await this.options.runtime.openVSCodeReview();
      } catch (error) {
        await this.returnToPlayerCode();
        throw new GameError('vscodeFailed', (error as Error).message);
      }
    });
  }

  /** Each step is recorded before it runs, so an interruption is finished or undone on the next start. */
  private async checkOutReview(ticket: number): Promise<void> {
    const { runtime } = this.options;
    try {
      const returnPoint = await runtime.reviewReturnPoint();
      let session: ReviewSession = { ticket, phase: 'saving', startedAt: this.ctx().now, returnPoint, wipCommit: null };
      await this.saveSession(session);
      session = { ...session, wipCommit: await runtime.reviewSaveWork(WIP_MESSAGE, this.excludes), phase: 'switching' };
      await this.saveSession(session);
      await runtime.reviewSwitch(ticket, excludesFileContent(this.review));
      await this.saveSession({ ...session, phase: 'open' });
    } catch (error) {
      await this.returnToPlayerCode().catch(() => {});
      throw new GameError('reviewFailed', (error as Error).message);
    }
  }

  /** "Back to my code". */
  async closeReview(): Promise<void> {
    if (!this.state.reviewSession) {
      return;
    }
    await this.requireDocker();
    await this.exclusive('closingReview', () => this.returnToPlayerCode());
  }

  async dismissReviewNotice(): Promise<void> {
    this.reviewNotice = null;
    this.emit();
  }

  /**
   * Before every action that depends on the player's code: bring it back if a review is checked out.
   * Called inside the action's exclusive task, so it never runs while another task changes the workspace.
   */
  private async beforePlayerCode(): Promise<void> {
    if (this.state.reviewSession) {
      await this.returnToPlayerCode();
    }
  }

  /** One return at a time, even when the start-up recovery and an action ask together. */
  private returnToPlayerCode(): Promise<void> {
    this.returning ??= this.bringBackPlayerCode().finally(() => {
      this.returning = null;
    });
    return this.returning;
  }

  /**
   * Checks the player's branch out again and undoes the temporary commit. Resumes an interrupted
   * checkout or return: in the saving phase the temporary commit exists only if it is HEAD.
   */
  private async bringBackPlayerCode(): Promise<void> {
    const session = this.state.reviewSession;
    if (!session) {
      return;
    }
    const { runtime } = this.options;
    let { wipCommit } = session;
    if (session.phase === 'saving') {
      const head = await runtime.headCommit();
      const point = session.returnPoint.head;
      wipCommit = head.commit !== point && head.parent === point && head.subject === WIP_MESSAGE ? head.commit : null;
    }
    await this.saveSession({ ...session, phase: 'returning', wipCommit });
    const result = await runtime.reviewReturn({
      ticket: session.ticket,
      point: session.returnPoint,
      wipCommit,
      stamp: editsStamp(this.ctx().now),
      editsMessage: reviewMessages(session.ticket).edits,
      excludes: this.excludes,
    });
    if (result.editsSaved || result.tipMoved) {
      this.reviewNotice = { ticket: session.ticket, kind: result.editsSaved ? 'editsSaved' : 'workKept' };
    }
    await this.saveSession(null);
  }

  // -------------------------------------------------------------------------
  // Export and restore

  async exportProgress(file: string): Promise<void> {
    await this.requireDocker();
    await this.exclusive('exporting', async () => {
      await this.beforePlayerCode();
      const packages = new Map<number, Uint8Array>();
      for (const ticket of this.state.tickets) {
        packages.set(ticket.ticket, await this.packages.readZip(ticket.ticket));
      }
      const reviews = await this.reviews.exportFiles();
      // The other projects have no code in Docker: their packages and PRs are all there is.
      const others = new Map<string, { packages: Map<number, Uint8Array>; reviews: Map<string, Uint8Array> }>();
      for (const [id, progress] of Object.entries(this.state.otherProjects)) {
        const store = this.options.projects!.packages(id);
        const zips = new Map<number, Uint8Array>();
        for (const ticket of progress.tickets) {
          zips.set(ticket.ticket, await store.readZip(ticket.ticket));
        }
        others.set(id, { packages: zips, reviews: await this.options.projects!.reviews(id).exportFiles() });
      }
      const bundle = await this.options.runtime.bundle();
      const at = this.ctx().now;
      // The save carries its own export record, so a restored game starts as backed up.
      const lastExport = { at, path: file };
      const state = { ...this.state, lastExport };
      await writeFileAtomic(file, createSave({ state, bundle, packages, reviews, others }, this.options.appVersion, at));
      await this.commit((current) => ({ ...current, lastExport }));
    });
  }

  /** Validates a save file and keeps it for restoreProgress (replacing an earlier one), returning a summary to confirm. */
  async inspectSave(file: string, fileName: string): Promise<{ token: string; summary: SaveSummary }> {
    // The earlier choice is dropped first, so two saves are never held at once.
    this.pendingSave = null;
    let validated: ValidatedSave;
    try {
      validated = readSave(new Uint8Array(await readFile(file)));
    } catch (error) {
      throw new GameError('invalidSave', (error as Error).message);
    }
    const token = randomUUID();
    this.pendingSave = { ...validated, fileName, token };
    return {
      token,
      summary: {
        fileName,
        createdAt: validated.manifest.createdAt,
        appVersion: validated.manifest.appVersion,
        ticketsDone: validated.state.tickets.filter((ticket) => ticket.status === 'done').length,
        currentTicket: validated.state.currentTicket,
        overwritesProgress: this.state.tickets.length > 0,
      },
    };
  }

  /** The player cancelled the restore: the save is no longer kept. */
  async discardSave(token: string): Promise<void> {
    if (this.pendingSave?.token === token) {
      this.pendingSave = null;
    }
  }

  /** Recreates the volume and repository from the bundle, then restores packages and state. */
  async restoreProgress(token: string): Promise<void> {
    const save = this.pendingSave?.token === token ? this.pendingSave : null;
    if (!save) {
      throw new GameError('invalidSave', 'Choose the save file again');
    }
    if (this.qaRun) {
      throw new GameError('busy');
    }
    await this.requireDocker();
    await this.exclusive('restoring', async () => {
      await this.beforePlayerCode();
      this.pendingSave = null;
      const current = save.state.currentTicket;
      // The save's active project becomes this game's: its stores, and the labels of its volume.
      const active = save.state.project ?? this.starterId();
      if (active) {
        this.useProject(active);
      }
      this.appendLog('» Recreating the workspace volume from the save');
      await this.options.runtime.restoreWorkspace(save.bundle, current === null ? null : playerBranch(current), save.state.createdAt);
      await this.packages.clear();
      for (const [stage, zip] of save.packages) {
        await this.packages.save(stage, zip);
      }
      await this.reviews.importSave(save.reviews);
      for (const [id, other] of save.others) {
        if (!this.options.projects || !this.catalog.some((item) => item.id === id)) {
          continue;
        }
        const store = this.options.projects.packages(id);
        await store.clear();
        for (const [stage, zip] of other.packages) {
          await store.save(stage, zip);
        }
        await this.options.projects.reviews(id).importSave(other.reviews);
      }
      // A save taken during QA restores as interrupted, like after a crash. Exports always return
      // from a review first, so a restored workspace never has one checked out.
      await this.commit((_state, ctx) => ({ ...rules.recoverInterruptedQa(save.state, ctx), reviewSession: null }));
      this.titles = {};
      await this.loadTicketMeta();
      const content = await this.source.current().catch(() => null);
      if (content) {
        await this.useContent(content);
      }
      await this.cleanOtherProjects().catch(() => {});
    });
    await this.refreshEnvironment().catch(() => {});
  }
}
