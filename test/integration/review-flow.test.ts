/**
 * The code review technique with real Docker and the notes fixture: approved snapshot
 * from an uncommitted fix, the review branch, the automatic checkout and return (with uncommitted,
 * untracked, ignored and excluded files), edits made on the review branch, crash recovery, a Done
 * review from the next ticket, the return before QA, recreation, export/restore and a new game.
 * Uses the "bugdetective-review-test" resource prefix, never the player's volumes. VS Code is not
 * launched: opening it is recorded instead.
 *
 *   pnpm run build && pnpm run test:integration
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Game } from '../../src/main/game.ts';
import { currentPlatform } from '../../src/main/platform/index.ts';
import { DockerRuntime } from '../../src/main/runtime.ts';
import { readZip } from '@bug-detective/catalog/contract';
import { LocalContentSource } from '../../src/main/services/content/local.ts';
import { PackageStore } from '../../src/main/services/content/store.ts';
import { Docker } from '../../src/main/services/docker.ts';
import { runCommand } from '../../src/main/services/process.ts';
import { ReviewStore } from '../../src/main/services/review/store.ts';
import { StateStore } from '../../src/main/services/state.ts';
import { WORKSPACE_DIR, Workspace } from '../../src/main/services/workspace.ts';
import * as rules from '../../src/shared/kanban.ts';
import { createNotesProject } from '../helpers/notes-project.ts';
import type { ProjectRepo } from '../helpers/project-repo.ts';
import { parseDiff, visibleFiles } from '../../src/renderer/src/components/diff.ts';

const root = resolve(import.meta.dirname, '..', '..');
const PREFIX = 'bugdetective-review-test';
const platform = currentPlatform();

/** The real runtime, except that opening VS Code is only counted. */
class TestRuntime extends DockerRuntime {
  vscodeOpened = 0;
  override async openVSCodeReview() {
    this.vscodeOpened += 1;
  }
}

let dir: string;
let docker: Docker;
let runtime: TestRuntime;
// The notes fixture laid out like a published project (test/helpers/notes-project.ts).
let notes: ProjectRepo;

function createGame(stateDir: string) {
  return new Game({
    store: new StateStore(stateDir),
    packages: new PackageStore(join(stateDir, 'packages')),
    reviews: new ReviewStore(join(stateDir, 'reviews')),
    content: new LocalContentSource({ qaDir: notes.qaDir, runner: runCommand }),
    runtime,
    appVersion: '0.1.0-test',
    versions: { electron: 'none', node: process.versions.node, chrome: 'none' },
  });
}

async function workspace(): Promise<Workspace> {
  const tags = JSON.parse(await readFile(join(root, 'build', 'docker', 'images.json'), 'utf8')) as { workspace: string };
  return new Workspace({ docker, image: tags.workspace, isPortFree: platform.isPortFree, names: runtime.names });
}

async function sh(script: string): Promise<string> {
  return (await docker.execChecked(runtime.names.container, ['sh', '-c', script], { user: 'node', workdir: WORKSPACE_DIR })).stdout.toString('utf8');
}

/** Branch, HEAD, index, status (with ignored files) and a hash of every file, node_modules included. */
const fingerprint = () =>
  sh(`echo "branch: $(git symbolic-ref -q --short HEAD)"; echo "head: $(git rev-parse HEAD)"; echo "index: $(git write-tree)"
git status --porcelain=v1 -uall --ignored | grep -v '^!! node_modules/' ; echo "node_modules: $(find node_modules -type f | wc -l)"
find . -path ./.git -prune -o -type f -print | sort | xargs sha256sum | sha256sum`);

const patch = (stage: number) => readFile(join(notes.qaDir, 'tickets', `front-${stage}`, 'reference.patch'), 'utf8');
const changedFiles = (diff: string) => visibleFiles(parseDiff(diff)).map((file) => `${file.status} ${file.path}`);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'João Silva bd-review-'));
  notes = await createNotesProject(join(dir, 'project'));
  const { cli } = await platform.locateDocker();
  if (!cli) throw new Error('The docker CLI was not found');
  docker = new Docker(cli, runCommand);
  runtime = new TestRuntime(platform, { contextRoot: join(root, 'build', 'docker'), qaBuildRoot: join(root, 'build', 'qa-contexts'), prefix: PREFIX });
  await (await workspace()).destroy();
});

afterAll(async () => {
  await (await workspace()).destroy();
  for (const volume of [runtime.names.vscodeVolume, runtime.names.cacheVolume, runtime.names.qaInputVolume]) {
    await docker.removeVolume(volume);
  }
  await rm(dir, { recursive: true, force: true });
});

describe('code review with real Docker', () => {
  let game: Game;
  let gameDir: string;

  it('captures the approved snapshot from an uncommitted fix, without touching the player branch', async () => {
    gameDir = join(dir, 'game');
    game = createGame(gameDir);
    await game.init();
    await game.installEnvironment();
    await game.nextAssignment();
    await game.installEnvironment();
    await game.move(1, 'inProgress');
    const ws = await workspace();
    await ws.applyPatch(await patch(1));
    // A helper only the player has, and a reformat with no logic change.
    await sh(`mkdir -p client/utils && printf 'export const trimmed = (text) => text.trim();\\n' > client/utils/text.js
sed -i 's/$/  /' client/sort.js`);
    const head = (await ws.git(['rev-parse', 'HEAD'])).trim();
    const status = await ws.git(['status', '--porcelain']);

    await game.move(1, 'inQa');
    await game.waitForQa();
    expect(rules.findTicket(game.current, 1)!.status).toBe('codeReview');

    // The player's branch, index and files are exactly as before.
    expect((await ws.git(['rev-parse', 'HEAD'])).trim()).toBe(head);
    expect(await ws.git(['status', '--porcelain'])).toBe(status);
    // The snapshot holds the files QA tested (the uncommitted fix), not HEAD, and no excluded file.
    const stored = (await new ReviewStore(join(gameDir, 'reviews')).load(1))!;
    const paths = (await ws.git(['ls-tree', '-r', '--name-only', 'qa-approved/ticket-1'])).trim().split('\n');
    expect(paths).toContain('client/utils/text.js');
    expect(paths.some((path) => /node_modules|package-lock\.json|\.db$/.test(path))).toBe(false);
    expect(await ws.git(['show', 'qa-approved/ticket-1:client/notes.js'])).toBe(await sh('cat client/notes.js'));
    // Only a diff is stored, and the ticket's commit plus that diff is exactly the approved snapshot.
    expect(stored.snapshotDiff).toContain('client/utils/text.js');
    expect(await ws.git(['diff', '--binary', '--full-index', 'refs/tags/stage-1', 'qa-approved/ticket-1'])).toBe(stored.snapshotDiff);
    // Tag and branch: never on the player branch.
    const { commits } = stored.meta;
    expect((await ws.git(['rev-parse', 'qa-approved/ticket-1'])).trim()).toBe(commits.approved);
    expect((await ws.git(['branch', '--contains', commits.approved, '--format=%(refname:short)'])).trim()).toBe('');
  });

  it('builds review/ticket-1 as reference then approved solution, read-only, with only the differing files', async () => {
    const ws = await workspace();
    const { meta } = (await new ReviewStore(join(gameDir, 'reviews')).load(1))!;
    expect((await ws.git(['log', '--format=%H %P|%s', 'review/ticket-1', '-3'])).trim().split('\n')).toEqual([
      `${meta.commits.snapshot} ${meta.commits.reference}|Your approved solution — ticket 1`,
      `${meta.commits.reference} ${(await ws.git(['rev-parse', 'stage-1^{commit}'])).trim()}|Reference — ticket 1`,
      expect.stringMatching(/Notes release front-1$/),
    ]);
    for (const commit of [meta.commits.reference, meta.commits.snapshot]) {
      expect(JSON.parse(await ws.git(['show', `${commit}:.vscode/settings.json`]))).toMatchObject({ 'files.readonlyInclude': { '**': true } });
    }
    // The snapshot commit's own diff is the review: the player's extra helper and the reformatted file.
    expect((await ws.git(['diff', '--name-status', meta.commits.reference, meta.commits.snapshot])).trim().split('\n').sort()).toEqual([
      'A\tclient/utils/text.js',
      'M\tclient/sort.js',
    ]);
    // In the app: the helper is "only in your solution"; the whitespace-only file shows with the toggle.
    expect(changedFiles(meta.comparison.solutionsIgnoringWhitespace)).toEqual(['deleted client/utils/text.js']);
    expect(changedFiles(meta.comparison.solutions).sort()).toEqual(['deleted client/utils/text.js', 'modified client/sort.js']);
    expect(changedFiles(meta.comparison.baselineIgnoringWhitespace)).toContain('modified client/notes.js');
  });

  it('opens the review and returns with uncommitted, untracked, ignored and excluded files exactly as before', async () => {
    const ws = await workspace();
    await sh(`echo "// after approval" >> server/api.js && git add server/api.js && echo "// unstaged" >> server/api.js
echo notes > NOTES.md && echo SECRET=1 > .env.local`);
    expect(await sh('ls server/data')).toMatch(/notes\.json/); // the project's database (db:reset), untracked and excluded
    const before = await fingerprint();
    const commitsBefore = await ws.git(['rev-list', '--count', 'player/ticket-1']);

    await game.openReview(1);
    expect(runtime.vscodeOpened).toBe(1);
    expect(game.current.reviewSession).toMatchObject({ ticket: 1, phase: 'open', returnPoint: { branch: 'player/ticket-1' } });
    expect(await ws.currentBranch()).toBe('review/ticket-1');
    // Source Control is clean during the review: excluded files are hidden, not committed.
    expect((await ws.git(['status', '--porcelain'])).trim()).toBe('');
    expect(await ws.git(['show', '--stat', '--format=%s', 'player/ticket-1'])).not.toMatch(/\.env\.local|server\/data|node_modules/);
    expect(await sh('cat .env.local; ls server/data')).toMatch(/SECRET=1[\s\S]*notes\.json/);

    await game.closeReview();
    expect(game.current.reviewSession).toBeNull();
    expect(game.snapshot().reviewNotice).toBeNull();
    expect(await fingerprint()).toBe(before);
    expect(await ws.git(['rev-list', '--count', 'player/ticket-1'])).toBe(commitsBefore);
  });

  it('saves edits made on the review branch separately and tells the player', async () => {
    const ws = await workspace();
    const before = await fingerprint();
    await game.openReview(1);
    await sh('echo "// typed in the terminal during the review" >> client/notes.js');
    await game.closeReview();
    expect(game.snapshot().reviewNotice).toEqual({ ticket: 1, kind: 'editsSaved' });
    expect(await fingerprint()).toBe(before);
    const [branch] = (await ws.git(['branch', '--list', 'review-edits/ticket-1-*', '--format=%(refname:short)'])).trim().split('\n');
    expect(await ws.git(['show', branch, '--', 'client/notes.js'])).toContain('typed in the terminal');
    await game.dismissReviewNotice();
  });

  it('recreates a missing review branch and tag from the stored data, with the same commits', async () => {
    const ws = await workspace();
    const { meta } = (await new ReviewStore(join(gameDir, 'reviews')).load(1))!;
    await ws.git(['branch', '-D', 'review/ticket-1']);
    await ws.git(['tag', '-d', 'qa-approved/ticket-1']);
    await game.openReview(1);
    expect((await ws.git(['rev-parse', 'HEAD'])).trim()).toBe(meta.commits.snapshot);
    expect((await ws.git(['rev-parse', 'qa-approved/ticket-1'])).trim()).toBe(meta.commits.approved);
    await game.closeReview();
  });

  it('after a crash during a review, the next start brings the player code back', async () => {
    const before = await fingerprint();
    await game.openReview(1);
    const restarted = createGame(gameDir);
    await restarted.init();
    expect(restarted.current.reviewSession?.phase).toBe('open');
    await restarted.refreshDockerState();
    await expect.poll(() => restarted.current.reviewSession, { timeout: 60_000 }).toBeNull();
    expect(await fingerprint()).toBe(before);
    game = restarted;
  });

  it('ticket 2 with different files: QA passes the player solution, and both files are matched by path', async () => {
    await game.acceptReview(1);
    await game.nextAssignment();
    await game.move(2, 'inProgress');
    const ws = await workspace();
    // The player cuts the preview like the reference but with a concatenation instead of a
    // template string, and writes no test of their own.
    await ws.applyPatch(await patch(2));
    await sh(`rm -f test/front-2.test.js
sed -i "s/\\\`\\\${line.slice(0, 39)}…\\\`/line.slice(0, 39) + '…'/" client/preview.js`);
    expect(await sh('cat client/preview.js')).toContain("line.slice(0, 39) + '…'");
    await game.move(2, 'inQa');
    await game.waitForQa();
    const ticket = rules.findTicket(game.current, 2)!;
    expect(ticket.attempts.at(-1)!.result).toMatchObject({ status: 'passed' });

    const { meta } = (await new ReviewStore(join(gameDir, 'reviews')).load(2))!;
    expect(changedFiles(meta.comparison.solutionsIgnoringWhitespace).sort()).toEqual([
      'added test/front-2.test.js',
      'modified client/preview.js',
    ]);
    // Matched by path: the preview file shows the player's version on the left, the reference's on the right.
    const preview = parseDiff(meta.comparison.solutionsIgnoringWhitespace).find((file) => file.path === 'client/preview.js')!;
    expect(preview.lines.some((line) => line.kind === 'del' && line.text.includes("line.slice(0, 39) + '…'"))).toBe(true);
    expect(preview.lines.some((line) => line.kind === 'add' && line.text.includes('${line.slice(0, 39)}…'))).toBe(true);
  });

  it('opens the Done review of ticket 1 from ticket 2 without checking out the old branch, and returns before QA', async () => {
    const ws = await workspace();
    await game.acceptReview(2);
    // The front track is done after two tickets: the third is back-1.
    await game.nextAssignment('back');
    await game.move(3, 'inProgress');
    await sh('echo "// marker of my ticket 3 work" >> server/api.js');
    const reflogBefore = (await ws.git(['reflog', '--format=%gs'])).split('\n').length;

    await game.openReview(1);
    expect(await ws.currentBranch()).toBe('review/ticket-1');
    expect(game.current.reviewSession?.returnPoint.branch).toBe('player/ticket-3');
    await game.move(3, 'inQa'); // returns first, then QA tests the player's code
    expect(game.current.reviewSession).toBeNull();
    expect(await ws.currentBranch()).toBe('player/ticket-3');
    await game.waitForQa();
    const tested = await runtime.testedFiles();
    expect(Buffer.from(tested.find((file) => file.path === 'server/api.js')!.data).toString('utf8')).toContain('marker of my ticket 3 work');
    const moves = (await ws.git(['reflog', '--format=%gs'])).split('\n').slice(0, -reflogBefore);
    expect(moves.join('\n')).not.toMatch(/to player\/ticket-1\b/);
  });

  it('every review works again after export, deleting the volume and restore', async () => {
    const save = join(dir, 'progress.bdsave');
    await game.exportProgress(save);
    await (await workspace()).destroy();

    const freshDir = join(dir, 'restored');
    const fresh = createGame(freshDir);
    await fresh.init();
    const { token } = await fresh.inspectSave(save, 'progress.bdsave');
    await fresh.restoreProgress(token);
    await fresh.installEnvironment();
    const ws = await workspace();
    for (const ticket of [1, 2]) {
      expect(await fresh.reviewComparison(ticket)).toEqual(await game.reviewComparison(ticket));
      await fresh.openReview(ticket);
      expect(await ws.currentBranch()).toBe(`review/ticket-${ticket}`);
      await fresh.closeReview();
    }
    expect(readZip(await readFile(save)).some((file) => file.path === 'reviews/ticket-2/snapshot.diff')).toBe(true);
    game = fresh;
  });

  it('a new game archives review branches and approved-snapshot tags with the player branches', async () => {
    const ws = await workspace();
    await game.newGame();
    await game.nextAssignment();
    expect((await ws.git(['branch', '--list', 'review/*'])).trim()).toBe('');
    expect((await ws.git(['tag', '--list', 'qa-approved/*'])).trim()).toBe('');
    expect(await ws.git(['branch', '--list', 'archive/*/review/ticket-1'])).toContain('review/ticket-1');
    expect(await ws.git(['tag', '--list', 'archive/*/qa-approved/ticket-2'])).toContain('qa-approved/ticket-2');
    expect(await game.reviewComparison(1).catch((error: { code: string }) => error.code)).toBe('noReview');
  });
});
