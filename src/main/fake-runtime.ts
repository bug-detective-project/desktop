/**
 * In-memory runtime for the Electron end-to-end tests (BUGDETECTIVE_E2E=1, development builds
 * only). Prerequisites and QA outcomes come from a JSON scenario; content still comes from the
 * real content source, so tickets, hints and reviews are the real ones.
 */
import { createHash } from 'node:crypto';
import type { DiskUsageItem, DockerCleanup, DockerCleanupScope, EngineState, EnvironmentReport, PrerequisiteReport, ReviewComparison } from '../shared/api.ts';
import type { QaResult } from '../shared/types.ts';
import type { GameRuntime, LineHandler, QaRequest } from './runtime.ts';
import { textFile } from '@bug-detective/catalog/contract';
import type { ArchiveFile } from '@bug-detective/catalog/contract';
import type { CleanupTarget } from './services/cleanup.ts';
import type { ReturnRequest, ReviewBuild, ReviewCommits } from './services/workspace.ts';

type QaOutcome = 'passed' | 'gate1' | 'gate2' | 'timeout' | 'error';

interface Scenario {
  docker: EngineState;
  wsl: boolean;
  vscode: boolean;
  devcontainers: boolean;
  environmentReady: boolean;
  qa: QaOutcome[];
  qaDelayMs: number;
  branch: string | null;
  /** Simulates Docker stopping in the middle of a session, right after the first unlock. */
  stopDockerAfterUnlock: boolean;
  /** "identical": the approved solution is exactly the reference (the revealed solution applied). */
  review: 'different' | 'identical';
  vscodeFails: boolean;
  /** Docker resources a cleanup cannot remove (by name), with Docker's reason. */
  cleanupFails: string[];
  /** Starting and stopping the dev server fail. */
  devServerFails: boolean;
  /** How long importing a stage takes, so the "unlocking" state can be seen. */
  unlockDelayMs: number;
  /** How long downloading the environment takes, so the install modal can be seen running. */
  installDelayMs: number;
  /** Downloading the environment fails with this message (after writing its log). */
  installFails: string | null;
}

const DEFAULT_SCENARIO: Scenario = {
  docker: 'running',
  wsl: true,
  vscode: true,
  devcontainers: true,
  environmentReady: true,
  qa: ['gate2', 'passed'],
  qaDelayMs: 300,
  branch: null,
  stopDockerAfterUnlock: false,
  review: 'different',
  vscodeFails: false,
  cleanupFails: [],
  devServerFails: false,
  unlockDelayMs: 0,
  installDelayMs: 0,
  installFails: null,
};

const fakeCommit = (text: string) => createHash('sha1').update(text).digest('hex');

/** Approved solution (old side) against the reference (new side), covering every kind of file entry. */
function solutionsDiff(whitespace: boolean): string {
  const large = Array.from({ length: 2100 }, (_, index) => `+export const row${index} = ${index};`).join('\n');
  return [
    'diff --git a/client/src/pages/TicketDetails.tsx b/client/src/pages/TicketDetails.tsx',
    'index 1111111..2222222 100644',
    '--- a/client/src/pages/TicketDetails.tsx',
    '+++ b/client/src/pages/TicketDetails.tsx',
    '@@ -74,4 +74,5 @@ export function TicketDetails() {',
    '   }, [search]);',
    ' ',
    '+  const activeEmployees = employees.filter((employee) => employee.active);',
    '   const position = resultIds.indexOf(Number(id));',
    '@@ -242,3 +243,3 @@ export function TicketDetails() {',
    '                 <option value="">Unassigned</option>',
    '-                {employees.map((employee) => (',
    '+                {activeEmployees.map((employee) => (',
    '                   <option key={employee.id} value={employee.id}>',
    'diff --git a/client/src/api/tickets.ts b/client/src/api/tickets.ts',
    'index 3333333..4444444 100644',
    '--- a/client/src/api/tickets.ts',
    '+++ b/client/src/api/tickets.ts',
    '@@ -60,3 +60,7 @@ export function updateTicket(id: number, values: TicketFormValues): Promise<Response> {',
    '-export function readErrorMessage(response: Response): Promise<string | undefined> {',
    '-  return errorFromBody(response);',
    '+export async function readErrorMessage(response: Response): Promise<string | undefined> {',
    '+  try {',
    '+    const body = await response.json();',
    '+    return typeof body?.error === \'string\' ? body.error : undefined;',
    '+  } catch {',
    ' }',
    'diff --git a/client/src/api/errors.ts b/client/src/api/errors.ts',
    'deleted file mode 100644',
    'index 5555555..0000000',
    '--- a/client/src/api/errors.ts',
    '+++ /dev/null',
    '@@ -1,2 +0,0 @@',
    '-/** Reads the "error" field of a failed API response. */',
    '-export async function errorFromBody(response: Response) {}',
    'diff --git a/client/src/pages/TicketDetails.assignment.test.tsx b/client/src/pages/TicketDetails.assignment.test.tsx',
    'new file mode 100644',
    'index 0000000..6666666',
    '--- /dev/null',
    '+++ b/client/src/pages/TicketDetails.assignment.test.tsx',
    '@@ -0,0 +1,2 @@',
    "+import { describe, it } from 'vitest';",
    "+describe('assignment', () => it('keeps the previous assignee when the update fails'));",
    'diff --git a/client/src/helpers.ts b/client/src/utils/helpers.ts',
    'similarity index 90%',
    'rename from client/src/helpers.ts',
    'rename to client/src/utils/helpers.ts',
    'index 7777777..8888888 100644',
    '--- a/client/src/helpers.ts',
    '+++ b/client/src/utils/helpers.ts',
    '@@ -1 +1 @@',
    '-export const helper = 1;',
    '+export const helper = 2;',
    'diff --git a/client/public/logo.png b/client/public/logo.png',
    'index 9999999..aaaaaaa 100644',
    'Binary files a/client/public/logo.png and b/client/public/logo.png differ',
    'diff --git a/client/src/generated/rows.ts b/client/src/generated/rows.ts',
    'index bbbbbbb..ccccccc 100644',
    '--- a/client/src/generated/rows.ts',
    '+++ b/client/src/generated/rows.ts',
    '@@ -0,0 +1,2100 @@',
    large,
    ...(whitespace
      ? [
          'diff --git a/client/src/searchParams.ts b/client/src/searchParams.ts',
          'index ddddddd..eeeeeee 100644',
          '--- a/client/src/searchParams.ts',
          '+++ b/client/src/searchParams.ts',
          '@@ -1 +1 @@',
          '-export const SEARCH = "search";   ',
          '+export const SEARCH = "search";',
        ]
      : ['diff --git a/client/src/searchParams.ts b/client/src/searchParams.ts', 'index ddddddd..eeeeeee 100644']),
    '',
  ].join('\n');
}

function baselineDiff(): string {
  return [
    'diff --git a/client/src/pages/TicketDetails.tsx b/client/src/pages/TicketDetails.tsx',
    'index 1111111..2222222 100644',
    '--- a/client/src/pages/TicketDetails.tsx',
    '+++ b/client/src/pages/TicketDetails.tsx',
    '@@ -242,3 +242,3 @@ export function TicketDetails() {',
    '                 <option value="">Unassigned</option>',
    '-                {employees.map((employee) => (',
    '+                {activeEmployees.map((employee) => (',
    '',
  ].join('\n');
}

const FAKE_SNAPSHOT = 'fake-snapshot:';

export class FakeRuntime implements GameRuntime {
  private readonly scenario: Scenario;
  private qaIndex = 0;
  private branch: string | null = null;
  private stages = new Map<number, string>();
  private devServerUp = false;

  constructor(json?: string) {
    this.scenario = { ...DEFAULT_SCENARIO, ...(json ? (JSON.parse(json) as Partial<Scenario>) : {}) };
  }

  async checkPrerequisites(): Promise<PrerequisiteReport> {
    const { docker, wsl, vscode, devcontainers } = this.scenario;
    const checks: PrerequisiteReport['checks'] = [
      docker === 'running' ? { id: 'docker', status: 'ok', version: '4.37.1' } : { id: 'docker', status: 'missing', reason: docker },
      wsl ? { id: 'wsl', status: 'ok', detail: 'docker-desktop (WSL 2)', version: '2.3.24.0' } : { id: 'wsl', status: 'missing', reason: 'notFound' },
      vscode ? { id: 'vscode', status: 'ok', version: '1.95.1' } : { id: 'vscode', status: 'missing', reason: 'cliNotFound' },
      devcontainers && vscode
        ? { id: 'devcontainers', status: 'ok', version: '0.388.0' }
        : { id: 'devcontainers', status: 'missing', reason: 'extensionMissing' },
    ];
    return { checks, allOk: checks.every((check) => check.status === 'ok'), dockerState: docker };
  }

  async dockerState() {
    return this.scenario.docker;
  }

  async startDocker(onPoll?: (state: EngineState) => void) {
    onPoll?.('starting');
    await new Promise((resolve) => setTimeout(resolve, 200));
    this.scenario.docker = 'running';
    return this.scenario.docker;
  }

  async installDevContainers() {
    if (!this.scenario.vscode) {
      throw new Error('VS Code was not found');
    }
    this.scenario.devcontainers = true;
  }

  /** The fake runtime never builds images, so the QA tool only has to be accepted. */
  setQaTool(_files: ArchiveFile[] | null): void {}

  /** Projects whose resources a test left behind, removed by removeProjects. */
  projectResources: Record<string, string[]> = {};

  setProject(_project: string): void {}

  async removeProjects(projects: readonly string[]): Promise<CleanupTarget[]> {
    for (const project of projects) {
      delete this.projectResources[project];
    }
    return [];
  }

  async environment(): Promise<EnvironmentReport> {
    const ready = this.scenario.environmentReady;
    return {
      items: [
        { id: 'workspaceImage', ready },
        { id: 'qaImage', ready },
      ],
      ready,
    };
  }

  async installEnvironment(onLine: LineHandler) {
    onLine('» docker build bugdetective-workspace (fake)');
    await new Promise((resolve) => setTimeout(resolve, this.scenario.installDelayMs));
    if (this.scenario.installFails) {
      throw new Error(this.scenario.installFails);
    }
    onLine('» docker build bugdetective-qa (fake)');
    this.scenario.environmentReady = true;
  }

  async cleanDocker(scope: DockerCleanupScope): Promise<DockerCleanup> {
    // Leftovers: a QA container, the QA input volume and an image of an older version.
    const targets: { kind: 'container' | 'volume' | 'image'; name: string }[] =
      scope === 'leftovers'
        ? [
            { kind: 'container', name: 'bugdetective-qa-1a2b3c4d' },
            { kind: 'volume', name: 'bugdetective-qa-input' },
            { kind: 'image', name: 'bugdetective-qa:0ld0ld0ld0ld' },
          ]
        : [
            { kind: 'container', name: 'bugdetective-workspace' },
            { kind: 'volume', name: 'bugdetective-workspace' },
            { kind: 'volume', name: 'bugdetective-vscode-server' },
            { kind: 'volume', name: 'bugdetective-qa-cache' },
            { kind: 'volume', name: 'bugdetective-qa-input' },
            { kind: 'image', name: 'bugdetective-workspace:281e4701af14' },
            { kind: 'image', name: 'bugdetective-qa:9c8db3bee0fc' },
          ];
    const failed = targets
      .filter((target) => this.scenario.cleanupFails.includes(target.name))
      .map((target) => ({ ...target, reason: `Error response from daemon: ${target.name} is in use` }));
    const result: DockerCleanup = { removed: targets.length - failed.length, failed };
    if (scope === 'everything') {
      result.workspaceKept = failed.some((target) => target.kind === 'volume' && target.name === 'bugdetective-workspace');
      this.scenario.environmentReady = false;
      if (!result.workspaceKept) {
        this.stages.clear();
        this.claimed = null;
      }
    }
    return result;
  }

  async diskUsage(): Promise<DiskUsageItem[]> {
    const ready = this.scenario.environmentReady;
    return [
      { id: 'workspaceVolume', bytes: this.stages.size > 0 ? 1_120_000_000 : null },
      { id: 'workspaceImage', bytes: ready ? 1_240_000_000 : null },
      { id: 'qaImage', bytes: ready ? 3_010_000_000 : null },
      { id: 'qaCache', bytes: ready ? 412_000_000 : null },
    ];
  }

  /** Records which game owns the fake workspace, like the real repository config. */
  claimed: string | null = null;

  async claimWorkspace(gameId: string) {
    const archived = this.claimed !== null && this.claimed !== gameId ? this.stages.size : 0;
    if (archived) {
      this.stages.clear();
      this.branch = null;
    }
    this.claimed = gameId;
    return archived;
  }

  async importStage(stage: number, files: ArchiveFile[]) {
    await new Promise((resolve) => setTimeout(resolve, this.scenario.unlockDelayMs));
    const commit = createHash('sha1').update(`stage-${stage}:${files.length}`).digest('hex');
    this.stages.set(stage, commit);
    return commit;
  }

  async checkoutPlayerBranch(stage: number) {
    this.branch = `player/ticket-${stage}`;
    if (this.scenario.stopDockerAfterUnlock) {
      setTimeout(() => {
        this.scenario.docker = 'notRunning';
      }, 500);
    }
  }

  /** Tickets whose workspace was reset to the stage, for tests. */
  resets: number[] = [];
  /** Reference patches applied by "Solve bug", for tests. */
  solved: { stage: number; patch: string }[] = [];

  async resetToStage(stage: number) {
    this.resets.push(stage);
    this.branch = `player/ticket-${stage}`;
    return { changes: 0, commits: 0 };
  }

  async currentBranch() {
    return this.scenario.branch ?? this.branch;
  }

  async resetDatabase() {}

  async hasRepository() {
    return this.stages.size > 0;
  }

  async workspacePorts() {
    return { client: 5173, api: 3001 };
  }

  async workspaceStatus() {
    return { ports: await this.workspacePorts(), devServerUp: this.devServerUp, branch: await this.currentBranch() };
  }

  async startDevServer() {
    if (this.scenario.devServerFails) {
      throw new Error('npm run dev failed (fake)');
    }
    this.devServerUp = true;
  }

  async stopDevServer() {
    if (this.scenario.devServerFails) {
      throw new Error('pkill failed (fake)');
    }
    this.devServerUp = false;
  }

  /**
   * For the e2e tests (through Playwright's app.evaluate): changes made outside the app, such as
   * Docker Desktop stopping or `npm run dev` started in the VS Code terminal.
   */
  simulate(change: { docker?: EngineState; devServerUp?: boolean }) {
    if (change.docker) this.scenario.docker = change.docker;
    if (change.devServerUp !== undefined) this.devServerUp = change.devServerUp;
  }

  async openVSCode() {}

  async testedFiles() {
    return [textFile('client/src/App.tsx', 'export {}\n'), textFile('package-lock.json', '{}\n')];
  }

  async solveBug(stage: number, patch: string) {
    this.solved.push({ stage, patch });
  }

  /** The fake "diff" to an approved commit is the snapshot it was built from, which referenceFiles applies back. */
  async commitDiff(_from: string, to: string): Promise<string> {
    const build = this.builds.find((item) => this.reviews.get(item.ticket)?.approved === to);
    return `${FAKE_SNAPSHOT}${JSON.stringify((build?.snapshot ?? []).map((file) => ({ path: file.path, text: Buffer.from(file.data).toString('utf8') })))}`;
  }

  async referenceFiles(stage: number, patch = '') {
    if (patch.startsWith(FAKE_SNAPSHOT)) {
      return (JSON.parse(patch.slice(FAKE_SNAPSHOT.length)) as { path: string; text: string }[]).map((file) => textFile(file.path, file.text));
    }
    return [textFile('client/src/App.tsx', `export {} // reference ${stage}\n`)];
  }

  /** Review branches built, by ticket, and every build request, for tests. */
  reviews = new Map<number, ReviewCommits>();
  builds: ReviewBuild[] = [];

  async buildReview(build: ReviewBuild) {
    this.builds.push(build);
    const seed = `${build.ticket}:${build.date}`;
    const commits = { approved: fakeCommit(`approved ${seed}`), reference: fakeCommit(`reference ${seed}`), snapshot: fakeCommit(`snapshot ${seed}`) };
    this.reviews.set(build.ticket, commits);
    return commits;
  }

  async reviewRefs(ticket: number) {
    const commits = this.reviews.get(ticket);
    return { branch: commits?.snapshot ?? null, tag: commits?.approved ?? null };
  }

  async reviewComparison(): Promise<ReviewComparison> {
    const identical = this.scenario.review === 'identical';
    return {
      solutions: identical ? '' : solutionsDiff(true),
      solutionsIgnoringWhitespace: identical ? '' : solutionsDiff(false),
      baseline: baselineDiff(),
      baselineIgnoringWhitespace: baselineDiff(),
    };
  }

  private head = fakeCommit('head');
  /** What HEAD looks like, for tests of an interrupted checkout. */
  headInfo: { commit: string; parent: string | null; subject: string } | null = null;
  /** Temporary commit returned by reviewSaveWork, for tests. */
  wipCommit: string | null = null;
  returns: ReturnRequest[] = [];
  /** Makes the next review checkout fail (a locked index), for tests. */
  failSwitch = false;

  async reviewReturnPoint() {
    return { branch: this.branch, head: this.head, indexTree: fakeCommit('index'), excludesFile: null };
  }

  async reviewSaveWork() {
    return this.wipCommit;
  }

  async headCommit() {
    return this.headInfo ?? { commit: this.head, parent: null, subject: 'Stage' };
  }

  /** The branch the player was on while a review is checked out, for tests. */
  private playerBranchDuringReview: string | null = null;

  async reviewSwitch(ticket: number) {
    if (this.failSwitch) {
      throw new Error("Unable to create '.git/index.lock': File exists.");
    }
    this.playerBranchDuringReview = this.branch;
    this.branch = `review/ticket-${ticket}`;
  }

  async reviewReturn(request: ReturnRequest) {
    this.returns.push(request);
    this.branch = request.point.branch ?? this.playerBranchDuringReview;
    return { editsSaved: false, tipMoved: false };
  }

  async openVSCodeReview() {
    if (this.scenario.vscodeFails) {
      throw new Error('VS Code was not found');
    }
  }

  async runQa(request: QaRequest): Promise<QaResult> {
    const outcome = this.scenario.qa[Math.min(this.qaIndex, this.scenario.qa.length - 1)];
    this.qaIndex += 1;
    request.onLine?.('Bug Detective QA (fake)');
    await new Promise((resolve) => setTimeout(resolve, this.scenario.qaDelayMs));
    const base = { ticket: request.ticket, message: '', durationMs: this.scenario.qaDelayMs };
    switch (outcome) {
      case 'passed':
        return { ...base, gate: 2, status: 'passed', tests: [{ name: 'Ticket validation', status: 'passed' }] };
      case 'gate1':
        return {
          ...base,
          gate: 1,
          status: 'failed',
          tests: [{ name: 'client/src/pages/TicketList.test.tsx > TicketList > renders', status: 'failed', error: 'expected 15 rows, got 0' }],
        };
      case 'timeout':
        return { ...base, gate: 2, status: 'timeout', tests: [{ name: 'Ticket validation > slow test', status: 'unfinished' }] };
      case 'error':
        throw new Error('Simulated infrastructure error');
      default:
        return {
          ...base,
          gate: 2,
          status: 'failed',
          tests: [
            { name: 'Gate 1 > project tests', status: 'passed' },
            { name: 'Ticket validation > Next shows the next ticket', status: 'failed', error: 'Expected "4", received "3"' },
          ],
        };
    }
  }

  async cleanupQaLeftovers() {}

  async bundle() {
    return null;
  }

  async restoreWorkspace() {}
}
