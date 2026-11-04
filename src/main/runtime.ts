/**
 * Everything the game needs from the outside world (Docker, the workspace, VS Code, QA),
 * behind one interface. DockerRuntime is the real one; test/e2e uses a fake (fake-runtime.ts).
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Language, QaResult } from '../shared/types.ts';
import type { DiskUsageItem, DockerCleanup, DockerCleanupScope, EnvironmentItem, EnvironmentReport, ReviewComparison, WorkspaceStatus } from '../shared/api.ts';
import type { Platform } from './platform/types.ts';
import { planCleanup } from './services/cleanup.ts';
import type { CleanupTarget } from './services/cleanup.ts';
import type { ArchiveFile } from '@bug-detective/catalog/contract';
import { DockerUnavailableError } from './services/docker.ts';
import { CommandError } from './services/process.ts';
import type { EngineState , Docker} from './services/docker.ts';
import { Prerequisites } from './services/prerequisites.ts';
import type { Environment } from './services/prerequisites.ts';
import type { PrerequisiteReport } from '../shared/api.ts';
import { QaRunner } from './services/qa.ts';
import { qaImageTag, writeQaContext } from './services/qa-image.ts';
import { Workspace, publishedPorts, resourceNames } from './services/workspace.ts';
import type { ResourceNames, ReturnPoint, ReturnRequest, ReturnResult, ReviewBuild, ReviewCommits, WorkspacePorts } from './services/workspace.ts';

export type LineHandler = (line: string) => void;

export interface QaRequest {
  ticket: number;
  language: Language;
  timeoutSeconds: number;
  packageDir: string;
  onLine?: LineHandler;
}

export interface GameRuntime {
  checkPrerequisites(): Promise<PrerequisiteReport>;
  dockerState(): Promise<EngineState>;
  startDocker(onPoll?: (state: EngineState) => void): Promise<EngineState>;
  installDevContainers(): Promise<void>;

  /** The QA tool of the project being played (its qa branch without the tickets), or null before it is downloaded. */
  setQaTool(files: ArchiveFile[] | null): void;
  /** The project whose Docker resources are created from now on (they carry its label and its folder); the name is known once the manifest is. */
  setProject(project: string, name?: string): void;
  /** Removes every Docker resource of these projects; returns what could not be removed (empty when clean). */
  removeProjects(projects: readonly string[]): Promise<CleanupTarget[]>;
  environment(): Promise<EnvironmentReport>;
  /** Downloads and installs everything the environment report lists as missing. Needs internet. */
  installEnvironment(onLine: LineHandler): Promise<void>;
  diskUsage(): Promise<DiskUsageItem[]>;
  /** Removes the app's Docker leftovers, or everything it created; one failure never stops the rest. */
  cleanDocker(scope: DockerCleanupScope): Promise<DockerCleanup>;

  /**
   * Makes the workspace repository belong to the game `gameId`, archiving player branches left by
   * another game. Returns the number of archived branches.
   */
  claimWorkspace(gameId: string): Promise<number>;
  /** "New game": removes what the previous game's code left in the repository (hooks, fsmonitor, command settings); nothing when Docker or the container is not running. */
  sanitizeWorkspace(): Promise<void>;
  importStage(stage: number, files: ArchiveFile[], message: string): Promise<string>;
  checkoutPlayerBranch(stage: number): Promise<void>;
  /** Discards everything on player/ticket-N and returns it to the clean stage commit. */
  resetToStage(stage: number): Promise<{ changes: number; commits: number }>;
  currentBranch(): Promise<string | null>;
  resetDatabase(): Promise<void>;
  hasRepository(): Promise<boolean>;

  workspacePorts(): Promise<WorkspacePorts | null>;
  /** Ports, dev server and branch. Read-only: never creates, starts or recreates anything. */
  workspaceStatus(): Promise<WorkspaceStatus>;
  startDevServer(): Promise<void>;
  stopDevServer(): Promise<void>;
  openVSCode(): Promise<void>;

  runQa(request: QaRequest): Promise<QaResult>;
  cleanupQaLeftovers(): Promise<void>;
  /** The app is closing: removes the QA containers and stops the workspace container (20 s at most; nothing when Docker is not running). */
  shutdown(): Promise<void>;
  /** The computer is going to sleep: the QA run in progress is killed (its containers removed); nothing when none runs. */
  abortQa(): Promise<void>;
  /** The files the last QA run tested (its own copy of the workspace). */
  testedFiles(): Promise<ArchiveFile[]>;

  /** Development only: the working tree gets the reference patch, as if the player had fixed the bug. */
  solveBug(stage: number, patch: string): Promise<void>;
  /** The stage commit with the reference patch applied. */
  referenceFiles(stage: number, patch: string): Promise<ArchiveFile[]>;
  /** git diff --binary between two commits of the workspace repository. */
  commitDiff(from: string, to: string): Promise<string>;
  /** Creates or recreates the approved-snapshot tag and the review branch. */
  buildReview(build: ReviewBuild): Promise<ReviewCommits>;
  reviewRefs(ticket: number): Promise<{ branch: string | null; tag: string | null }>;
  /** The comparison diffs, computed by git from the review commits. */
  reviewComparison(stage: number, commits: ReviewCommits, excludes: readonly string[]): Promise<ReviewComparison>;
  reviewReturnPoint(): Promise<ReturnPoint>;
  reviewSaveWork(message: string, excludes: readonly string[]): Promise<string | null>;
  headCommit(): Promise<{ commit: string; parent: string | null; subject: string }>;
  reviewSwitch(ticket: number, excludesFile: string): Promise<void>;
  reviewReturn(request: ReturnRequest): Promise<ReturnResult>;
  /** Opens VS Code attached to the workspace, reusing a window already open on it. */
  openVSCodeReview(): Promise<void>;

  bundle(): Promise<Uint8Array | null>;
  /** Replaces the workspace volume with the repository in `bundle`, checked out at `branch`. */
  restoreWorkspace(bundle: Uint8Array | null, branch: string | null, gameId?: string): Promise<void>;
}

export interface ImageConfig {
  /** Folder with workspace/, qa/ and images.json (build/docker in development, resources/docker when packaged). */
  contextRoot: string;
  /** Where the QA image's build contexts are assembled (docker/qa/ plus the project's QA tool). */
  qaBuildRoot: string;
  /** The QA image repository; bugdetective-qa, so every game shares one image per QA tool. */
  qaRepository?: string;
  /** Prefix of every Docker resource name (tests use their own). */
  prefix?: string;
}

interface ImageTags {
  workspace: string;
  /** Hash of the app's docker/qa/ files; the QA tag also hashes the project's QA tool. */
  qaBase: string;
}

/** Docker's own words for a failed removal ("Error response from daemon: …"), or that it did not answer. */
function cleanupReason(error: unknown): string {
  if (error instanceof CommandError) {
    if (error.result.timedOut) {
      return 'Docker did not answer in time';
    }
    const lines = error.result.stderr.split(/\r?\n/).filter((line) => line.trim());
    return (lines.at(-1) ?? error.message).slice(0, 300);
  }
  return (error as Error).message.slice(0, 300);
}

export class DockerRuntime implements GameRuntime {
  private readonly platform: Platform;
  private readonly prerequisites: Prerequisites;
  private readonly contextRoot: string;
  private readonly qaBuildRoot: string;
  private readonly qaRepository: string;
  private qaTool: ArchiveFile[] | null = null;
  private project: string | null = null;
  private projectName: string | null = null;
  readonly names: ResourceNames;
  private located: Environment | null = null;
  private tags: ImageTags | null = null;
  /** The QA run in progress, aborted by shutdown() so it starts no further container. */
  private qaAbort: AbortController | null = null;

  constructor(platform: Platform, images: ImageConfig) {
    this.platform = platform;
    this.prerequisites = new Prerequisites(platform);
    this.contextRoot = images.contextRoot;
    this.qaBuildRoot = images.qaBuildRoot;
    this.qaRepository = images.qaRepository ?? 'bugdetective-qa';
    this.names = resourceNames(images.prefix);
  }

  private async env(refresh = false): Promise<Environment> {
    if (refresh || !this.located || !this.located.docker || !this.located.vscode) {
      this.located = await this.prerequisites.locate();
    }
    return this.located;
  }

  private async imageTags(): Promise<ImageTags> {
    this.tags ??= JSON.parse(await readFile(join(this.contextRoot, 'images.json'), 'utf8')) as ImageTags;
    return this.tags;
  }

  setQaTool(files: ArchiveFile[] | null): void {
    this.qaTool = files;
  }

  setProject(project: string, name?: string): void {
    if (project !== this.project) {
      this.projectName = null;
    }
    this.project = project;
    this.projectName = name ?? this.projectName;
  }

  async removeProjects(projects: readonly string[]): Promise<CleanupTarget[]> {
    const docker = await this.docker();
    const left = async (): Promise<CleanupTarget[]> => {
      const targets: CleanupTarget[] = [];
      for (const project of projects) {
        const found = await docker.ofProject(project);
        targets.push(
          ...found.containers.map((name) => ({ kind: 'container' as const, name })),
          ...found.volumes.map((name) => ({ kind: 'volume' as const, name })),
          ...found.images.map(({ ref, id }) => ({ kind: 'image' as const, name: ref.endsWith(':<none>') ? id : ref })),
        );
      }
      return targets;
    };
    // Containers first (they hold the volumes and the images); a failed removal is retried by the next call.
    for (const target of await left()) {
      try {
        if (target.kind === 'container') await docker.removeContainer(target.name);
        else if (target.kind === 'volume') await docker.removeVolume(target.name);
        else await docker.removeImage(target.name, { force: true });
      } catch {
        // Reported below, by what is still there.
      }
    }
    return left();
  }

  /** The QA image of the current QA tool, or null before the project's content is downloaded. */
  private async qaTag(): Promise<string | null> {
    return this.qaTool ? qaImageTag((await this.imageTags()).qaBase, this.qaTool, this.qaRepository) : null;
  }

  /** The docker CLI, if the engine is running. */
  private async docker(): Promise<Docker> {
    const env = await this.env();
    if (!env.docker || !(await env.docker.serverVersion())) {
      throw new DockerUnavailableError();
    }
    return env.docker;
  }

  private async workspace(): Promise<Workspace> {
    const docker = await this.docker();
    return new Workspace({
      docker,
      image: (await this.imageTags()).workspace,
      isPortFree: (port) => this.platform.isPortFree(port),
      names: this.names,
      project: this.project,
      projectName: this.projectName,
    });
  }

  /** The workspace, with its container running. */
  private async runningWorkspace(): Promise<Workspace> {
    const workspace = await this.workspace();
    await workspace.ensureRunning();
    return workspace;
  }

  private async qa(): Promise<QaRunner> {
    return new QaRunner({
      docker: await this.docker(),
      image: await this.requireQaTag(),
      dockerHostPath: (path) => this.platform.dockerHostPath(path),
      names: this.names,
      project: this.project,
    });
  }

  private async requireQaTag(): Promise<string> {
    const tag = await this.qaTag();
    if (!tag) {
      throw new Error("The project's QA tool has not been downloaded yet");
    }
    return tag;
  }

  async checkPrerequisites() {
    return this.prerequisites.check(await this.env(true));
  }

  async dockerState() {
    return this.prerequisites.dockerState(await this.env());
  }

  async startDocker(onPoll?: (state: EngineState) => void) {
    return this.prerequisites.startDocker(await this.env(true), 180_000, onPoll);
  }

  async installDevContainers() {
    const { vscode } = await this.env(true);
    if (!vscode) {
      throw new Error('VS Code was not found');
    }
    await vscode.installDevContainers();
  }

  async environment(): Promise<EnvironmentReport> {
    const docker = await this.docker();
    const tags = await this.imageTags();
    const qa = await this.qaTag();
    const items: EnvironmentItem[] = [
      { id: 'workspaceImage', ready: await docker.imageExists(tags.workspace) },
      { id: 'qaImage', ready: qa !== null && (await docker.imageExists(qa)) },
    ];
    if (items[0].ready && (await docker.volumeExists(this.names.volume))) {
      const workspace = await this.runningWorkspace();
      const key = (await workspace.hasRepository()) ? await workspace.dependencyKey() : null;
      if (key) {
        const ready = (await workspace.cachedDependencies(key)) && (await workspace.installedDependencyKey()) === key;
        items.push({ id: 'projectDependencies', ready });
      }
    }
    return { items, ready: items.every((item) => item.ready) };
  }

  async installEnvironment(onLine: LineHandler) {
    const docker = await this.docker();
    const tags = await this.imageTags();
    if (!(await docker.imageExists(tags.workspace))) {
      onLine(`» docker build ${tags.workspace}`);
      await docker.build(this.platform.dockerHostPath(join(this.contextRoot, 'workspace')), tags.workspace, 'workspace-image', (line) => onLine(line), undefined, null, this.names.prefix);
    }
    const qa = await this.requireQaTag();
    if (!(await docker.imageExists(qa))) {
      const context = await writeQaContext(join(this.contextRoot, 'qa'), tags.qaBase, this.qaTool!, this.qaBuildRoot);
      onLine(`» docker build ${qa}`);
      await docker.build(this.platform.dockerHostPath(context), qa, 'qa-image', (line) => onLine(line), undefined, this.project, this.names.prefix);
    }
    // The workspace container moves to the new image first: the image of an older version is then
    // free and goes away with the other leftovers (an image a container still uses stays).
    const workspace = await this.runningWorkspace();
    const old = await this.cleanDocker('leftovers').catch(() => null);
    if (old && old.removed > 0) {
      onLine(`» Removed ${old.removed} item(s) left by older versions`);
    }
    if (!(await workspace.hasRepository())) {
      return;
    }
    const key = await workspace.dependencyKey();
    if (!key) {
      return;
    }
    if (!(await workspace.cachedDependencies(key))) {
      onLine('» npm ci (QA dependency cache)');
      const branch = await workspace.currentBranch();
      const stage = Number(/^player\/ticket-(\d+)$/.exec(branch ?? '')?.[1] ?? 1);
      await (await this.qa()).prepareDependencies(stage, (line) => onLine(line));
    }
    if ((await workspace.installedDependencyKey()) !== key) {
      onLine('» Installing node_modules into the workspace');
      await workspace.installDependenciesFromCache(key, (line) => onLine(line));
      onLine('» npm run db:reset');
      await workspace.resetDatabase((line) => onLine(line));
    }
  }

  async diskUsage(): Promise<DiskUsageItem[]> {
    const docker = await this.docker();
    const tags = await this.imageTags();
    const qa = await this.qaTag();
    const [workspaceImage, qaImage, volumes] = await Promise.all([
      docker.imageSize(tags.workspace),
      qa ? docker.imageSize(qa) : Promise.resolve(null),
      docker.volumeSizes([this.names.volume, this.names.cacheVolume]),
    ]);
    return [
      { id: 'workspaceVolume', bytes: volumes[this.names.volume] ?? null },
      { id: 'workspaceImage', bytes: workspaceImage },
      { id: 'qaImage', bytes: qaImage },
      { id: 'qaCache', bytes: volumes[this.names.cacheVolume] ?? null },
    ];
  }

  async cleanDocker(scope: DockerCleanupScope): Promise<DockerCleanup> {
    const docker = await this.docker();
    const tags = await this.imageTags();
    const targets = planCleanup(await docker.labelled(), {
      scope,
      prefix: this.names.prefix,
      qaInputVolume: this.names.qaInputVolume,
      currentImages: [tags.workspace, await this.qaTag()].filter((tag): tag is string => tag !== null),
    });
    const result: DockerCleanup = { removed: 0, failed: [] };
    for (const target of targets) {
      try {
        if (target.kind === 'container') {
          await docker.removeContainer(target.name);
          if (await docker.inspectContainer(target.name)) {
            throw new Error('The container is still there');
          }
        } else if (target.kind === 'volume') {
          await docker.removeVolume(target.name);
        } else {
          // Leftovers keep an image that a container still uses; everything removes it by force.
          await docker.removeImage(target.name, { force: scope === 'everything' });
        }
        result.removed += 1;
      } catch (error) {
        result.failed.push({ kind: target.kind, name: target.name, reason: cleanupReason(error) });
      }
    }
    if (scope === 'everything') {
      result.workspaceKept = await docker.volumeExists(this.names.volume);
      // The builder (its BuildKit container and cache) goes with the app's data.
      await docker.removeBuilder(this.names.prefix);
    }
    return result;
  }

  async claimWorkspace(gameId: string) {
    return (await this.runningWorkspace()).claimForGame(gameId);
  }

  async sanitizeWorkspace() {
    let workspace: Workspace;
    try {
      workspace = await this.workspace();
    } catch (error) {
      if (error instanceof DockerUnavailableError) return;
      throw error;
    }
    if (!(await workspace.info())?.running || !(await workspace.hasRepository())) return;
    await workspace.sanitizeRepository();
  }

  async importStage(stage: number, files: ArchiveFile[], message: string) {
    return (await this.runningWorkspace()).importStage(stage, files, message);
  }

  async checkoutPlayerBranch(stage: number) {
    await (await this.runningWorkspace()).checkoutPlayerBranch(stage);
  }

  async resetToStage(stage: number) {
    return (await this.runningWorkspace()).resetToStage(stage);
  }

  async currentBranch() {
    return (await this.runningWorkspace()).currentBranch();
  }

  async resetDatabase() {
    const workspace = await this.runningWorkspace();
    const key = await workspace.dependencyKey();
    if (key && (await workspace.installedDependencyKey()) === key) {
      await workspace.resetDatabase();
    }
  }

  async hasRepository() {
    return (await this.runningWorkspace()).hasRepository();
  }

  async workspacePorts() {
    return (await this.runningWorkspace()).ports();
  }

  async workspaceStatus(): Promise<WorkspaceStatus> {
    const workspace = await this.workspace();
    const info = await workspace.info();
    if (!info?.running) {
      return { ports: null, devServerUp: false, branch: null };
    }
    const [devServerUp, branch] = await Promise.all([workspace.isDevServerUp(), workspace.currentBranch()]);
    return { ports: publishedPorts(info), devServerUp, branch };
  }

  async startDevServer() {
    await (await this.runningWorkspace()).startDevServer();
  }

  async stopDevServer() {
    await (await this.runningWorkspace()).stopDevServer();
  }

  async openVSCode() {
    const workspace = await this.runningWorkspace();
    const { vscode } = await this.env();
    if (!vscode) {
      throw new Error('VS Code was not found');
    }
    await vscode.openAttached(workspace.containerName, workspace.dir);
  }

  async testedFiles() {
    return (await this.qa()).testedFiles();
  }

  async solveBug(stage: number, patch: string) {
    await (await this.runningWorkspace()).solveBug(stage, patch);
  }

  async commitDiff(from: string, to: string) {
    return (await this.runningWorkspace()).git(['diff', '--binary', '--full-index', from, to]);
  }

  async referenceFiles(stage: number, patch: string) {
    return (await this.runningWorkspace()).referenceFiles(stage, patch);
  }

  async buildReview(build: ReviewBuild) {
    return (await this.runningWorkspace()).buildReview(build);
  }

  async reviewRefs(ticket: number) {
    return (await this.runningWorkspace()).reviewRefs(ticket);
  }

  async reviewComparison(stage: number, commits: ReviewCommits, excludes: readonly string[]): Promise<ReviewComparison> {
    const workspace = await this.runningWorkspace();
    const baseline = `refs/tags/stage-${stage}`;
    return {
      solutions: await workspace.diff(commits.snapshot, commits.reference),
      solutionsIgnoringWhitespace: await workspace.diff(commits.snapshot, commits.reference, { ignoreWhitespace: true }),
      baseline: await workspace.diff(baseline, commits.approved, { pathspecs: excludes }),
      baselineIgnoringWhitespace: await workspace.diff(baseline, commits.approved, { ignoreWhitespace: true, pathspecs: excludes }),
    };
  }

  async reviewReturnPoint() {
    return (await this.runningWorkspace()).reviewReturnPoint();
  }

  async reviewSaveWork(message: string, excludes: readonly string[]) {
    return (await this.runningWorkspace()).reviewSaveWork(message, excludes);
  }

  async headCommit() {
    return (await this.runningWorkspace()).headCommit();
  }

  async reviewSwitch(ticket: number, excludesFile: string) {
    await (await this.runningWorkspace()).reviewSwitch(ticket, excludesFile);
  }

  async reviewReturn(request: ReturnRequest) {
    return (await this.runningWorkspace()).reviewReturn(request);
  }

  async openVSCodeReview() {
    const workspace = await this.runningWorkspace();
    const { vscode } = await this.env();
    if (!vscode) {
      throw new Error('VS Code was not found');
    }
    await vscode.openAttached(workspace.containerName, workspace.dir, { reuseWindow: true });
  }

  async runQa(request: QaRequest) {
    await this.runningWorkspace();
    const controller = new AbortController();
    this.qaAbort = controller;
    try {
      return await (await this.qa()).run({ ...request, signal: controller.signal, onLine: request.onLine && ((line) => request.onLine!(line)) });
    } finally {
      if (this.qaAbort === controller) this.qaAbort = null;
    }
  }

  async cleanupQaLeftovers() {
    await (await this.qa()).cleanupLeftovers();
  }

  async abortQa() {
    if (!this.qaAbort) return;
    this.qaAbort.abort();
    const docker = await this.docker().catch(() => null);
    if (!docker) return;
    await (await this.qa().catch(() => null))?.cleanupLeftovers().catch(() => {});
  }

  async shutdown() {
    // First no new QA container: the run in progress stops at its next step, and the cleanup below removes what exists.
    this.qaAbort?.abort();
    let docker: Docker;
    try {
      docker = await this.docker();
    } catch (error) {
      if (error instanceof DockerUnavailableError) return;
      throw error;
    }
    const signal = AbortSignal.timeout(20_000);
    // The QA containers first (a run in progress is killed), then the workspace: its volume stays,
    // the dev server and VS Code's server stop with it. "No such container" is fine.
    await (await this.qa().catch(() => null))?.cleanupLeftovers().catch(() => {});
    await docker.run(['container', 'stop', '--time', '5', this.names.container], { timeoutMs: 15_000, signal });
  }

  async bundle() {
    const workspace = await this.workspace();
    if (!(await workspace.volumeExists())) {
      return null;
    }
    await workspace.ensureRunning();
    return (await workspace.hasRepository()) ? workspace.bundle() : null;
  }

  async restoreWorkspace(bundle: Uint8Array | null, branch: string | null, gameId?: string) {
    const workspace = await this.workspace();
    if (bundle) {
      // A bad bundle must fail here, while the current volume still exists.
      await workspace.ensureRunning();
      await workspace.verifyBundle(bundle);
    }
    await workspace.destroy();
    await workspace.ensureRunning();
    if (bundle && branch) {
      await workspace.restoreBundle(bundle, branch);
    }
    if (bundle && branch && gameId) {
      // The restored repository is this game's own work: mark it, archive nothing.
      await workspace.setGameId(gameId);
    }
  }
}
