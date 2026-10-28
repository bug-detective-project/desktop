/**
 * The code review technique on a second, fake learning project (test/fixtures/tasklist: a few
 * Python files, its own reference patch and review configuration), with real Docker and git:
 * approved snapshot, review branch, checkout and return, through configuration only. The project
 * has no QA suite, so QA is replaced by its first step only: the copy of the workspace QA tests.
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
import { buildStagePackages } from '../../src/main/services/content/packages.ts';
import { PackageStore } from '../../src/main/services/content/store.ts';
import { Docker } from '../../src/main/services/docker.ts';
import { runChecked, runCommand } from '../../src/main/services/process.ts';
import type { QaRunner } from '../../src/main/services/qa.ts';
import { loadReviewConfig } from '../../src/main/services/review/config.ts';
import { ReviewStore } from '../../src/main/services/review/store.ts';
import { StateStore } from '../../src/main/services/state.ts';
import { WORKSPACE_DIR, Workspace } from '../../src/main/services/workspace.ts';
import * as rules from '../../src/shared/kanban.ts';
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
  override async resetDatabase() {}
}

let dir: string;
let docker: Docker;
let runtime: FixtureRuntime;

async function sh(script: string): Promise<string> {
  return (await docker.execChecked(runtime.names.container, ['sh', '-c', script], { user: 'node', workdir: WORKSPACE_DIR })).stdout.toString('utf8');
}

const fingerprint = () =>
  sh(`git symbolic-ref -q --short HEAD; git rev-parse HEAD; git write-tree; git status --porcelain=v1 -uall --ignored
find . -path ./.git -prune -o -type f -print | sort | xargs sha256sum`);

/** A content repository like supportdesk-private: branch stage-1 with the code, qa/stages/stage-1/ with the package. */
async function fixtureRepository(): Promise<{ repo: string; manifest: string }> {
  const repo = join(dir, 'tasklist-repo');
  const git = (...args: string[]) => runChecked(runCommand, 'git', ['-C', repo, ...args]);
  await mkdir(repo, { recursive: true });
  await git('init', '-q', '-b', 'stage-1');
  await git('config', 'user.name', 'Fixture');
  await git('config', 'user.email', 'fixture@example.invalid');
  await cp(join(fixture, 'stage-1'), repo, { recursive: true });
  await git('add', '-A');
  await git('commit', '-q', '-m', 'Tasklist release 1.0');
  await cp(join(fixture, 'package'), join(repo, 'qa', 'stages', 'stage-1'), { recursive: true });
  const out = join(dir, 'tasklist-packages');
  await buildStagePackages({ repo, out, version: '0.0.1', runner: runCommand });
  return { repo, manifest: join(out, 'manifest.json') };
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-generic-'));
  const { cli } = await platform.locateDocker();
  if (!cli) throw new Error('The docker CLI was not found');
  docker = new Docker(cli, runCommand);
  runtime = new FixtureRuntime(platform, { contextRoot: join(root, 'build', 'docker'), prefix: PREFIX });
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
    const { repo, manifest } = await fixtureRepository();
    const configFile = join(dir, 'configs', 'projects', 'tasklist', 'review.json');
    await mkdir(join(configFile, '..'), { recursive: true });
    await writeFile(configFile, await readFile(join(fixture, 'review.json')));
    const review = loadReviewConfig('tasklist', { [configFile.replaceAll('\\', '/')]: JSON.parse(await readFile(configFile, 'utf8')) });

    const gameDir = join(dir, 'game');
    const game = new Game({
      store: new StateStore(gameDir),
      packages: new PackageStore(join(gameDir, 'packages')),
      reviews: new ReviewStore(join(gameDir, 'reviews')),
      review,
      content: new LocalContentSource({ repoPath: repo, manifestPath: manifest, runner: runCommand }),
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
});
