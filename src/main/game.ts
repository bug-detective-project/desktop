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
  TicketContent,
} from '../shared/api.ts';
import * as rules from '../shared/kanban.ts';
import type { RuleContext } from '../shared/kanban.ts';
import { HINTS_PER_TICKET, LANGUAGES, MAX_QA_TIMEOUT_SECONDS, MIN_QA_TIMEOUT_SECONDS } from '../shared/types.ts';
import type { Column, GameState, Language, ReviewSession, Settings } from '../shared/types.ts';
import type { GameRuntime } from './runtime.ts';
import { createSave, readSave } from './services/backup.ts';
import { fileText } from './services/content/archive.ts';
import type { ArchiveFile } from './services/content/archive.ts';
import type { ValidatedSave } from './services/backup.ts';
import type { ContentSource } from './services/content/source.ts';
import type { PackageStore } from './services/content/store.ts';
import { writeFileAtomic } from './services/content/store.ts';
import { DockerUnavailableError } from './services/docker.ts';
import { excludeMatcher, excludePathspecs, excludesFileContent } from './services/review/config.ts';
import type { ReviewConfig } from './services/review/config.ts';
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

export interface GameOptions {
  store: StateStore;
  packages: PackageStore;
  reviews: ReviewStore;
  /** The review configuration of the project being played. */
  review: ReviewConfig;
  content: ContentSource;
  runtime: GameRuntime;
  appVersion: string;
  versions: Snapshot['versions'];
  /** Development only: allows "Solve bug" (never set by the packaged app). */
  devSolveBug?: boolean;
  /** Called after every change, with the new snapshot. */
  onChange?: (snapshot: Snapshot) => void;
  clock?: () => Date;
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
  private pendingSaves = new Map<string, ValidatedSave & { fileName: string }>();
  private reviewNotice: ReviewNotice | null = null;
  /** A review was still checked out when the app started: bring the player's code back once Docker answers. */
  private recoverReview = false;
  private returning: Promise<void> | null = null;

  constructor(options: GameOptions) {
    this.options = options;
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
    await this.loadTicketMeta();
  }

  get current(): GameState {
    return this.state;
  }

  snapshot(): Snapshot {
    return {
      state: this.state,
      nextTicket: rules.nextTicketNumber(this.state),
      titles: this.titles,
      hintsTotal: this.hintsTotal,
      busy: this.busy,
      dockerState: this.dockerState,
      prerequisites: this.prerequisites,
      environment: this.environment,
      log: this.log,
      reviewNotice: this.reviewNotice,
      contentSource: `${this.options.content.kind}: ${this.options.content.describe()}`,
      appVersion: this.options.appVersion,
      versions: this.options.versions,
      devSolveBug: this.options.devSolveBug ?? false,
    };
  }

  private emit(): void {
    this.options.onChange?.(this.snapshot());
  }

  private appendLog(line: string): void {
    this.log = [...this.log, line].slice(-LOG_LINES);
    this.emit();
  }

  private async commit(next: GameState): Promise<void> {
    await this.options.store.save(next);
    this.state = next;
    this.emit();
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
        const markdown = (await this.options.packages.readText(ticket.ticket, `ticket.${language}.md`)) ?? '';
        titles[language] = /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? `Ticket ${ticket.ticket}`;
      }
      this.titles[ticket.ticket] = titles;
      const hints = await this.options.packages.readText(ticket.ticket, 'hints.en.json');
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
    await this.requireDocker();
    await this.exclusive('installing', () => this.options.runtime.installEnvironment((line) => this.appendLog(line)));
    return this.refreshEnvironment();
  }

  // -------------------------------------------------------------------------
  // Assignments

  /**
   * Unlocks the next stage. Download and verification happen first; the workspace is only
   * touched once everything is verified, so a failed download can simply be retried.
   */
  async nextAssignment(): Promise<void> {
    const ticket = rules.nextTicketNumber(this.state);
    if (ticket === null) {
      this.apply((state) => {
        rules.assertCanUnlock(state, state.tickets.length + 1);
        return state;
      });
      throw new GameError('noMoreTickets');
    }
    await this.requireDocker();
    await this.beforePlayerCode();
    await this.exclusive('unlocking', async () => {
      this.appendLog(`» Fetching stage ${ticket} from ${this.options.content.describe()}`);
      const fetched = await this.options.content.fetchStage(ticket);
      this.appendLog(`» Verified ${fetched.codeFiles.length} files and the stage package (SHA-256)`);
      await this.options.packages.save(ticket, fetched.packageZip);
      // The volume outlives the saved game: work from another game is archived, never reused.
      const archived = await this.options.runtime.claimWorkspace(this.state.createdAt);
      if (archived > 0) {
        this.appendLog(`» Kept the code of a previous game in the workspace history (${archived} ticket(s))`);
      }
      const commit = await this.options.runtime.importStage(ticket, fetched.codeFiles, fetched.entry.commitMessage);
      await this.options.runtime.claimWorkspace(this.state.createdAt);
      this.appendLog(`» Imported as commit ${commit.slice(0, 12)}`);
      await this.options.runtime.checkoutPlayerBranch(ticket);
      this.appendLog(`» Workspace ready for ticket ${ticket}`);
      await this.options.runtime.resetDatabase().catch(() => {});
      await this.commit(this.apply((state, ctx) => rules.unlockTicket(state, ticket, commit, ctx)));
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
    await this.commit(this.apply((state, ctx) => rules.playerMove(state, ticket, to, ctx)));
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
    await this.beforePlayerCode();
    await this.exclusive('starting', async () => {
      const discarded = await this.options.runtime.resetToStage(ticket);
      if (discarded.changes > 0 || discarded.commits > 0) {
        this.appendLog(`» Workspace reset to stage ${ticket}: discarded ${discarded.changes} changed file(s) and ${discarded.commits} commit(s)`);
      }
      await this.options.runtime.resetDatabase().catch(() => {});
      await this.commit(this.apply((state, ctx) => rules.playerMove(state, ticket, 'inProgress', ctx)));
    });
  }

  /** Moving to In QA: checks the environment, moves the card and runs QA in the background. */
  private async submitToQa(ticket: number): Promise<void> {
    // Validate the move before any slow check, so forbidden moves fail fast.
    this.apply((state, ctx) => rules.playerMove(state, ticket, 'inQa', ctx));
    if (this.busy) {
      throw new GameError('busy', `Busy: ${this.busy}`);
    }
    await this.requireDocker();
    await this.beforePlayerCode();
    const environment = await this.refreshEnvironment();
    if (!environment.ready) {
      throw new GameError('environmentNotReady');
    }
    const startedAt = this.ctx().now;
    await this.commit(this.apply((state, ctx) => rules.playerMove(state, ticket, 'inQa', ctx)));
    this.busy = 'qa';
    this.log = [];
    this.emit();
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
    const { runtime, packages } = this.options;
    const timeoutSeconds = this.state.settings.qaTimeoutSeconds;
    try {
      const branch = await runtime.currentBranch();
      const branchWarning = branch !== playerBranch(ticket);
      if (branchWarning) {
        await this.commit(this.apply((state, ctx) => rules.addBranchWarning(state, ticket, branch, ctx)));
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
      await this.commit(
        this.apply((state, ctx) => rules.recordQaResult(state, ticket, { startedAt, branch, branchWarning, timeoutSeconds, result, playerDiff }, ctx)),
      );
    } catch (error) {
      const detail = error instanceof DockerUnavailableError ? 'Docker stopped while QA was running.' : (error as Error).message;
      await this.commit(this.apply((state, ctx) => rules.recordQaError(state, ticket, detail.slice(0, 4000), ctx)));
      await this.refreshDockerState();
    }
  }

  async askSenior(ticket: number): Promise<void> {
    await this.commit(this.apply((state, ctx) => rules.revealHint(state, ticket, this.hintsTotal[ticket] ?? HINTS_PER_TICKET, ctx)));
  }

  async revealSolution(ticket: number): Promise<void> {
    await this.commit(this.apply((state, ctx) => rules.revealSolution(state, ticket, this.hintsTotal[ticket] ?? HINTS_PER_TICKET, ctx)));
  }

  /** Accepting uses only the approved snapshot; with Docker stopped, the player's code comes back later. */
  async acceptReview(ticket: number): Promise<void> {
    this.apply((state, ctx) => rules.acceptReview(state, ticket, ctx));
    if (this.state.reviewSession && (await this.refreshDockerState()) === 'running') {
      await this.returnToPlayerCode();
    }
    await this.commit(this.apply((state, ctx) => rules.acceptReview(state, ticket, ctx)));
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
      await this.returnToPlayerCode();
    }
    await this.startOver();
  }

  /** A fresh game that keeps the preferences; downloaded packages and reviews are removed. */
  private async startOver(): Promise<void> {
    const { language, theme, qaTimeoutSeconds } = this.state.settings;
    const fresh = rules.createInitialState(this.ctx(), language);
    await this.options.packages.clear();
    await this.options.reviews.clear();
    this.titles = {};
    this.hintsTotal = {};
    // Nothing of the old game is recovered or reported in the new one.
    this.recoverReview = false;
    this.reviewNotice = null;
    await this.commit({ ...fresh, settings: { ...fresh.settings, theme, qaTimeoutSeconds } });
  }

  /** "Clean up leftovers": QA leftovers and images of older versions. The player's work stays. */
  async cleanDockerLeftovers(): Promise<DockerCleanup> {
    return this.exclusive('cleaningDocker', async () => {
      await this.requireDocker();
      const result = await this.options.runtime.cleanDocker('leftovers');
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
    await this.commit(rules.markInboxRead(this.state, id));
  }

  async updateSettings(settings: Partial<Settings>): Promise<void> {
    const next = { ...this.state.settings, ...settings };
    next.qaTimeoutSeconds = Math.min(MAX_QA_TIMEOUT_SECONDS, Math.max(MIN_QA_TIMEOUT_SECONDS, Math.round(next.qaTimeoutSeconds)));
    await this.commit({ ...this.state, settings: next });
  }

  /** Ticket texts and what the player has unlocked so far: hints, solution, review. */
  async ticketContent(ticket: number, language: Language): Promise<TicketContent> {
    const current = rules.findTicket(this.state, ticket);
    if (!current) {
      throw new GameError('noSuchTicket');
    }
    const read = (file: string) => this.options.packages.readText(ticket, file);
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

  async workspaceStatus() {
    await this.requireDocker();
    const { runtime } = this.options;
    const [ports, devServerUp, branch] = await Promise.all([
      runtime.workspacePorts(),
      runtime.isDevServerUp(),
      runtime.currentBranch().catch(() => null),
    ]);
    return { ports, devServerUp, branch };
  }

  async openVSCode(): Promise<void> {
    await this.requireDocker();
    await this.beforePlayerCode();
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
    await this.beforePlayerCode();
    await this.exclusive('solvingBug', async () => {
      const patch = await this.options.packages.readText(ticket, 'reference.patch');
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
    return excludePathspecs(this.options.review);
  }

  /**
   * After a QA pass: stores the approved snapshot (the files QA tested, after the excludes) and the
   * reference, creates the tag and the review branch, and computes the comparison. Returns the
   * player's diff against the stage.
   */
  private async captureApproval(ticket: number): Promise<string> {
    const { runtime, packages, reviews, review } = this.options;
    this.appendLog('» Saving the approved solution for the code review');
    const excluded = excludeMatcher(review);
    const snapshot = (await runtime.testedFiles()).filter((file) => !excluded(file.path));
    const reference = await runtime.referenceFiles(ticket, (await packages.readText(ticket, 'reference.patch')) ?? '');
    const meta = { ticket, approvedAt: this.ctx().now, language: this.state.settings.language };
    const commits = await this.buildReviewBranch(meta, snapshot, reference);
    const comparison = await runtime.reviewComparison(ticket, commits, this.excludes);
    // The ticket is still In QA: an earlier pass that failed to record may be replaced.
    await reviews.save({ meta: { ...meta, commits, comparison }, snapshot, reference }, { replace: true });
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
    const stored = await this.options.reviews.load(ticket);
    if (!stored) {
      throw new GameError('noReview');
    }
    const refs = await this.options.runtime.reviewRefs(ticket);
    if (refs.branch === stored.meta.commits.snapshot && refs.tag === stored.meta.commits.approved) {
      return;
    }
    this.appendLog('» Rebuilding the review from the saved solution');
    const commits = await this.buildReviewBranch(stored.meta, stored.snapshot, stored.reference);
    if (JSON.stringify(commits) !== JSON.stringify(stored.meta.commits)) {
      await this.options.reviews.save({ ...stored, meta: { ...stored.meta, commits } });
    }
  }

  private requireReviewable(ticket: number): void {
    const current = rules.findTicket(this.state, ticket);
    if (!current || (current.status !== 'codeReview' && current.status !== 'done') || !this.options.reviews.has(ticket)) {
      throw new GameError('noReview');
    }
  }

  /** The stored comparison; needs no Docker. */
  async reviewComparison(ticket: number): Promise<ReviewComparison> {
    this.requireReviewable(ticket);
    return (await this.options.reviews.comparison(ticket))!;
  }

  private async saveSession(session: ReviewSession | null): Promise<void> {
    await this.commit({ ...this.state, reviewSession: session });
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
      await runtime.reviewSwitch(ticket, excludesFileContent(this.options.review));
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

  /** Before every action that depends on the player's code: bring it back if a review is checked out. */
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
    await this.beforePlayerCode();
    await this.exclusive('exporting', async () => {
      const packages = new Map<number, Uint8Array>();
      for (const ticket of this.state.tickets) {
        packages.set(ticket.ticket, await this.options.packages.readZip(ticket.ticket));
      }
      const reviews = await this.options.reviews.exportFiles();
      const bundle = await this.options.runtime.bundle();
      const at = this.ctx().now;
      // The save carries its own export record, so a restored game starts as backed up.
      const state = { ...this.state, lastExport: { at, path: file } };
      await writeFileAtomic(file, createSave({ state, bundle, packages, reviews }, this.options.appVersion, at));
      await this.commit(state);
    });
  }

  /** Validates a save file and keeps it for restoreProgress, returning a summary to confirm. */
  async inspectSave(file: string, fileName: string): Promise<{ token: string; summary: SaveSummary }> {
    let validated: ValidatedSave;
    try {
      validated = readSave(new Uint8Array(await readFile(file)), this.ctx());
    } catch (error) {
      throw new GameError('invalidSave', (error as Error).message);
    }
    const token = randomUUID();
    this.pendingSaves.set(token, { ...validated, fileName });
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

  /** Recreates the volume and repository from the bundle, then restores packages and state. */
  async restoreProgress(token: string): Promise<void> {
    const save = this.pendingSaves.get(token);
    if (!save) {
      throw new GameError('invalidSave', 'Choose the save file again');
    }
    if (this.qaRun) {
      throw new GameError('busy');
    }
    await this.requireDocker();
    await this.beforePlayerCode();
    await this.exclusive('restoring', async () => {
      this.pendingSaves.delete(token);
      const current = save.state.currentTicket;
      this.appendLog('» Recreating the workspace volume from the save');
      await this.options.runtime.restoreWorkspace(save.bundle, current === null ? null : playerBranch(current), save.state.createdAt);
      await this.options.packages.clear();
      for (const [stage, zip] of save.packages) {
        await this.options.packages.save(stage, zip);
      }
      await this.options.reviews.importSave(save.reviews);
      // A save taken during QA restores as interrupted, like after a crash. Exports always return
      // from a review first, so a restored workspace never has one checked out.
      await this.commit({ ...rules.recoverInterruptedQa(save.state, this.ctx()), reviewSession: null });
      this.titles = {};
      await this.loadTicketMeta();
    });
    await this.refreshEnvironment().catch(() => {});
  }
}
