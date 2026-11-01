/**
 * A second, fake learning project (test/fixtures/tasklist: a few Python files, its own reference
 * patch and review configuration), laid out like a published one (main, a qa worktree with
 * tickets/<id>/, and the ticket branches front-1, front-2 and back-1), with real Docker and git:
 * the code review technique through configuration only, and a queue of three tickets that proves
 * nothing depends on SupportDesk or on four tickets. The project has no QA suite, so QA is
 * replaced by its first step only: the copy of the workspace QA tests.
 */
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Game } from '../../src/main/game.ts';
import { currentPlatform } from '../../src/main/platform/index.ts';
import { DockerRuntime } from '../../src/main/runtime.ts';
import type { QaRequest } from '../../src/main/runtime.ts';
import { LocalContentSource } from '../../src/main/services/content/local.ts';
import { PackageStore } from '../../src/main/services/content/store.ts';
import { Docker } from '../../src/main/services/docker.ts';
import { runChecked, runCommand } from '../../src/main/services/process.ts';
import type { QaRunner } from '../../src/main/services/qa.ts';
import { parseReviewConfig } from '../../src/main/services/review/config.ts';
import { ReviewStore } from '../../src/main/services/review/store.ts';
import { StateStore } from '../../src/main/services/state.ts';
import { WORKSPACE_DIR, Workspace } from '../../src/main/services/workspace.ts';
import * as rules from '../../src/shared/kanban.ts';
import { projectStory, ticketFiles, writeFiles } from '../helpers/project-repo.ts';
import { qaToolFiles } from '../../src/main/services/content/project-files.ts';
import { readQaFiles } from '../../src/main/services/content/publish.ts';
import type { QaResult } from '../../src/shared/types.ts';
import { parseDiff, visibleFiles } from '../../src/renderer/src/components/diff.ts';

const root = resolve(import.meta.dirname, '..', '..');
const fixture = join(root, 'test', 'fixtures', 'tasklist');
const PREFIX = 'bugdetective-generic-test';
const platform = currentPlatform();

/** Real Docker and git; QA only copies the workspace (as the real QA does first) and passes. */
class FixtureRuntime extends DockerRuntime {
  override async runQa(request: QaRequest): Promise<QaResult> {
    const qa = await (this as unknown as { qa(): Promise<QaRunner> }).qa();
    await (qa as unknown as { copyWorkspace(): Promise<void> }).copyWorkspace();
    return { ticket: request.ticket, gate: 2, status: 'passed', message: '', tests: [], durationMs: 1 };
  }
  override async openVSCodeReview() {}
  // The fixture has no QA tool of its own: the QA image is SupportDesk's, which the other tests build.
  override setQaTool() {
    super.setQaTool(supportdeskTool);
  }
  override async resetDatabase() {}
}

let dir: string;
let supportdeskTool: Awaited<ReturnType<typeof qaToolFiles>>;
let docker: Docker;
let runtime: FixtureRuntime;

async function sh(script: string): Promise<string> {
  return (await docker.execChecked(runtime.names.container, ['sh', '-c', script], { user: 'node', workdir: WORKSPACE_DIR })).stdout.toString('utf8');
}

const fingerprint = () =>
  sh(`git symbolic-ref -q --short HEAD; git rev-parse HEAD; git write-tree; git status --porcelain=v1 -uall --ignored
find . -path ./.git -prune -o -type f -print | sort | xargs sha256sum`);

/** The tasklist project: main is the fixed app; front-1 is the fixture's stage, front-2 and back-1 break other files. */
async function fixtureProject(): Promise<{ qaDir: string; patches: Record<string, string> }> {
  const repo = join(dir, 'tasklist');
  const qaDir = join(dir, 'tasklist-qa');
  const git = async (cwd: string, ...args: string[]) => (await runChecked(runCommand, 'git', ['-C', cwd, ...args])).stdout.toString('utf8');
  await mkdir(repo, { recursive: true });
  await git(repo, 'init', '-q', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Fixture');
  await git(repo, 'config', 'user.email', 'fixture@example.invalid');
  await cp(join(fixture, 'stage-1'), repo, { recursive: true });
  await git(repo, 'apply', join(fixture, 'package', 'reference.patch'));
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'Tasklist');

  // A ticket branch: an orphan commit of main with one file broken; its reference patch fixes it.
  const patches: Record<string, string> = { 'front-1': await readFile(join(fixture, 'package', 'reference.patch'), 'utf8') };
  await git(repo, 'checkout', '-q', '--orphan', 'front-1');
  await git(repo, 'rm', '-rq', '--cached', '.');
  await rm(join(repo, 'app'), { recursive: true });
  await rm(join(repo, 'tests'), { recursive: true });
  await cp(join(fixture, 'stage-1'), repo, { recursive: true });
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-q', '-m', 'Tasklist release front-1');
  for (const [id, file, from, to] of [
    ['front-2', 'app/format.py', "'x' if task['done'] else ' '", "' ' if task['done'] else 'x'"],
    ['back-1', 'README.md', 'A tiny task list', 'A tiny tsak list'],
  ]) {
    await git(repo, 'checkout', '-q', '-f', 'main');
    await git(repo, 'checkout', '-q', '--orphan', id);
    const path = join(repo, ...file.split('/'));
    await writeFile(path, (await readFile(path, 'utf8')).replace(from, to));
    await git(repo, 'add', '-A');
    await git(repo, 'commit', '-q', '-m', `Tasklist release ${id}`);
    patches[id] = await git(repo, 'diff', id, 'main', '--', file);
  }
  await git(repo, 'checkout', '-q', '-f', 'main');

  await git(repo, 'worktree', 'add', '-q', '--detach', qaDir, 'main');
  await git(qaDir, 'checkout', '-q', '--orphan', 'qa');
  await git(qaDir, 'rm', '-rqf', '.');
  await writeFiles(qaDir, {
    'package.json': JSON.stringify({ bugDetective: { project: { id: 'tasklist', name: 'Tasklist' } } }),
    'story.en.json': projectStory('Tasklist', ['front-1', 'front-2', 'back-1']),
    'story.pt.json': projectStory('Tasklist', ['front-1', 'front-2', 'back-1']),
  });
  for (const [id, title] of [
    ['front-1', 'TL-1: Finished tasks still show as remaining'],
    ['front-2', 'TL-2: Done and open tasks have swapped marks'],
    ['back-1', 'TL-3: A typo in the README'],
  ]) {
    await writeFiles(join(qaDir, 'tickets', id), {
      ...ticketFiles(id),
      'ticket.en.md': `# ${title}\n`,
      'ticket.pt.md': `# ${title}\n`,
      'reference.patch': patches[id],
    });
  }
  await cp(join(fixture, 'package', 'review.en.md'), join(qaDir, 'tickets', 'front-1', 'review.en.md'));
  await git(qaDir, 'add', '-A');
  await git(qaDir, 'commit', '-q', '-m', 'QA suite');
  return { qaDir, patches };
}

async function tasklistReview() {
  const configFile = join(dir, 'configs', 'projects', 'tasklist', 'review.json');
  await mkdir(join(configFile, '..'), { recursive: true });
  await writeFile(configFile, await readFile(join(fixture, 'review.json')));
  return parseReviewConfig(JSON.parse(await readFile(configFile, 'utf8')));
}

let project: { qaDir: string; patches: Record<string, string> };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-generic-'));
  supportdeskTool = qaToolFiles(await readQaFiles(resolve(root, '..', 'supportdesk-qa'), runCommand));
  project = await fixtureProject();
  const { cli } = await platform.locateDocker();
  if (!cli) throw new Error('The docker CLI was not found');
  docker = new Docker(cli, runCommand);
  runtime = new FixtureRuntime(platform, { contextRoot: join(root, 'build', 'docker'), qaBuildRoot: join(root, 'build', 'qa-contexts'), prefix: PREFIX });
  const tags = JSON.parse(await readFile(join(root, 'build', 'docker', 'images.json'), 'utf8')) as { workspace: string };
  await new Workspace({ docker, image: tags.workspace, isPortFree: platform.isPortFree, names: runtime.names }).destroy();
});

afterAll(async () => {
  const tags = JSON.parse(await readFile(join(root, 'build', 'docker', 'images.json'), 'utf8')) as { workspace: string };
  await new Workspace({ docker, image: tags.workspace, isPortFree: platform.isPortFree, names: runtime.names }).destroy();
  for (const volume of [runtime.names.vscodeVolume, runtime.names.cacheVolume, runtime.names.qaInputVolume]) {
    await docker.removeVolume(volume);
  }
  await rm(dir, { recursive: true, force: true });
});

describe('a second learning project, through configuration only', () => {
  it('captures the snapshot, builds the review branch, and checks it out and back', async () => {
    const review = await tasklistReview();

    const gameDir = join(dir, 'game');
    const game = new Game({
      store: new StateStore(gameDir),
      packages: new PackageStore(join(gameDir, 'packages')),
      reviews: new ReviewStore(join(gameDir, 'reviews')),
      review,
      content: new LocalContentSource({ qaDir: project.qaDir, runner: runCommand }),
      runtime,
      appVersion: '0.1.0-test',
      versions: { electron: 'none', node: process.versions.node, chrome: 'none' },
    });
    await game.init();
    await game.nextAssignment();
    expect(game.snapshot().titles[1].en).toBe('TL-1: Finished tasks still show as remaining');
    await game.move(1, 'inProgress');

    // The player's own fix, a helper, a changed lockfile and generated files the project ignores nowhere.
    await sh(`sed -i 's/if task\\["done"\\]]/if task["done"] is False]/' app/tasks.py
printf 'def count(tasks):\\n    return len(tasks)\\n' > app/helpers.py
printf 'pytest==8.3.4\\n' > requirements.lock
mkdir -p app/__pycache__ && printf 'bytecode' > app/__pycache__/tasks.cpython-312.pyc && printf 'rows' > data.sqlite`);
    await game.move(1, 'inQa');
    await game.waitForQa();
    expect(rules.findTicket(game.current, 1)!.status).toBe('codeReview');

    // Snapshot and comparison follow the project's configuration plus the built-in defaults.
    const stored = (await new ReviewStore(join(gameDir, 'reviews')).load(1))!;
    expect(stored.snapshot.map((file) => file.path).sort()).toEqual(['README.md', 'app/format.py', 'app/helpers.py', 'app/tasks.py']);
    const files = visibleFiles(parseDiff(stored.meta.comparison.solutionsIgnoringWhitespace)).map((file) => `${file.status} ${file.path}`);
    expect(files.sort()).toEqual(['added tests/test_tasks.py', 'deleted app/helpers.py', 'modified app/tasks.py']);

    // Checkout and return: the lockfile change stays uncommitted, generated files untouched.
    const before = await fingerprint();
    await game.openReview(1);
    expect(await sh('git symbolic-ref --short HEAD; git status --porcelain; cat requirements.lock')).toBe('review/ticket-1\n M requirements.lock\npytest==8.3.4\n');
    expect(await sh('git show --stat --format=%s player/ticket-1')).not.toMatch(/requirements\.lock|\.pyc|sqlite/);
    await game.closeReview();
    expect(await fingerprint()).toBe(before);
    expect(await sh('git rev-list --count player/ticket-1')).toBe('1\n');
  });

  it('plays two front tickets and one back ticket as fullstack, each solved with its reference patch', async () => {
    const gameDir = join(dir, 'queue');
    const game = new Game({
      store: new StateStore(gameDir),
      packages: new PackageStore(join(gameDir, 'packages')),
      reviews: new ReviewStore(join(gameDir, 'reviews')),
      review: await tasklistReview(),
      content: new LocalContentSource({ qaDir: project.qaDir, runner: runCommand }),
      runtime,
      appVersion: '0.1.0-test',
      versions: { electron: 'none', node: process.versions.node, chrome: 'none' },
      devSolveBug: true,
    });
    await game.init();
    await game.newGame();
    const completions = () => game.current.inbox.filter((m) => m.kind === 'completion' || m.kind === 'trackCompletion').map((m) => `${m.kind}:${m.track}`);
    const expected = { 1: [], 2: ['completion:back'], 3: ['completion:back', 'trackCompletion:front', 'trackCompletion:fullstack'] };
    // Fullstack alternates, front first: front-1, back-1, then front-2 (the back queue is finished).
    for (const [position, id] of [[1, 'front-1'], [2, 'back-1'], [3, 'front-2']] as const) {
      await game.nextAssignment('fullstack');
      expect(rules.findTicket(game.current, position)).toMatchObject({ id, track: id.split('-')[0], status: 'todo' });
      expect(game.current.tracks).toEqual({ front: 2, back: 1 });
      await game.move(position, 'inProgress');
      await game.solveBug(position);
      // The workspace is the ticket's commit plus exactly its reference patch.
      const patch = project.patches[id];
      const files = [...patch.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((match) => match[1]).sort();
      expect((await sh(`git diff --name-only refs/tags/stage-${position}`)).split('\n').filter(Boolean).sort()).toEqual(
        files.filter((file) => !file.startsWith('tests/')),
      );
      await sh(`cat > /tmp/reference.patch <<'PATCH'\n${patch}PATCH\ngit apply --check -R /tmp/reference.patch`);
      await game.move(position, 'inQa');
      await game.waitForQa();
      await game.acceptReview(position);
      expect(completions()).toEqual(expected[position]);
    }
    expect(game.snapshot().queues?.fullstack.next).toBeNull();
    expect(game.snapshot().nextTicket).toBeNull();
  });
});
