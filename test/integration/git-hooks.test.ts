/**
 * The app's git never runs the repository's hooks or fsmonitor, whatever the player's code planted
 * (loose end 46), and "New game" removes them. Real Docker, the notes fixture, the
 * "bugdetective-hooks-test" prefix.
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
import { LocalContentSource } from '../../src/main/services/content/local.ts';
import { PackageStore } from '../../src/main/services/content/store.ts';
import { Docker } from '../../src/main/services/docker.ts';
import { runCommand } from '../../src/main/services/process.ts';
import { ReviewStore } from '../../src/main/services/review/store.ts';
import { StateStore } from '../../src/main/services/state.ts';
import { Workspace, workspaceDir } from '../../src/main/services/workspace.ts';
import { createNotesProject } from '../helpers/notes-project.ts';

const root = resolve(import.meta.dirname, '..', '..');
const PREFIX = 'bugdetective-hooks-test';
const platform = currentPlatform();
const DIR = workspaceDir('notes');

let dir: string;
let docker: Docker;
let runtime: DockerRuntime;
let game: Game;

async function workspace(): Promise<Workspace> {
  const tags = JSON.parse(await readFile(join(root, 'build', 'docker', 'images.json'), 'utf8')) as { workspace: string };
  return new Workspace({ docker, image: tags.workspace, isPortFree: platform.isPortFree, names: runtime.names, project: 'notes' });
}

/** Runs a shell script in the repository as the player would (the real git, hooks and all). */
async function sh(script: string): Promise<string> {
  return (await docker.execChecked(runtime.names.container, ['sh', '-c', script], { user: 'node', workdir: DIR })).stdout.toString('utf8').trim();
}

const exists = (path: string) => docker.exec(runtime.names.container, ['test', '-e', path], { user: 'node' }).then((result) => result.code === 0);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-hooks-'));
  const notes = await createNotesProject(join(dir, 'project'));
  const { cli } = await platform.locateDocker();
  if (!cli) throw new Error('The docker CLI was not found');
  docker = new Docker(cli, runCommand);
  runtime = new DockerRuntime(platform, { contextRoot: join(root, 'build', 'docker'), qaBuildRoot: join(root, 'build', 'qa-contexts'), prefix: PREFIX });
  await (await workspace()).destroy();
  game = new Game({
    store: new StateStore(dir),
    packages: new PackageStore(join(dir, 'packages')),
    reviews: new ReviewStore(join(dir, 'reviews')),
    content: new LocalContentSource({ qaDir: notes.qaDir, runner: runCommand }),
    runtime,
    appVersion: '0.1.0-test',
    versions: { electron: 'none', node: process.versions.node, chrome: 'none' },
  });
  await game.init();
  await game.installEnvironment();
  await game.nextAssignment();
});

afterAll(async () => {
  await (await workspace()).destroy();
  await docker.removeVolume(runtime.names.vscodeVolume);
  await docker.removeVolume(runtime.names.cacheVolume);
  await docker.removeVolume(runtime.names.qaInputVolume);
  await rm(dir, { recursive: true, force: true });
});

describe('git hooks planted in the workspace', () => {
  it('never run under the app\'s git operations, while the player\'s own git still runs them', async () => {
    await sh(`printf '#!/bin/sh\ntouch /tmp/hook-ran\n' > .git/hooks/post-checkout && chmod +x .git/hooks/post-checkout
git config core.fsmonitor 'touch /tmp/fsmonitor-ran'
git config filter.evil.clean 'touch /tmp/filter-ran'
rm -f /tmp/hook-ran /tmp/fsmonitor-ran /tmp/filter-ran`);
    const ws = await workspace();
    await ws.resetToStage(1);
    await ws.checkoutPlayerBranch(1);
    await ws.git(['status', '--porcelain']);
    await ws.git(['add', '-A']);
    expect(await exists('/tmp/hook-ran')).toBe(false);
    expect(await exists('/tmp/fsmonitor-ran')).toBe(false);
    expect(await exists('/tmp/filter-ran')).toBe(false);

    // The player's git (a terminal in VS Code) is not the app's business: the hook does run there.
    await sh('git checkout -q player/ticket-1');
    expect(await exists('/tmp/hook-ran')).toBe(true);
  });

  it('"New game" removes the hooks, the fsmonitor and the drivers from the repository', async () => {
    await game.newGame();
    expect(await sh('ls .git/hooks | wc -l')).toBe('0');
    expect(await sh('git config --get core.fsmonitor || echo none')).toBe('none');
    expect(await sh('git config --get filter.evil.clean || echo none')).toBe('none');
  });
});
