/**
 * The workspace volume removed outside the game (a Docker cleanup, a prune), with real Docker: the
 * game notices it, refuses the code actions, and recreates the code of every ticket from the
 * cached packages. The notes fixture, the "bugdetective-lost-test" prefix.
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
const PREFIX = 'bugdetective-lost-test';
const platform = currentPlatform();

let dir: string;
let docker: Docker;
let runtime: DockerRuntime;
let game: Game;

async function workspace(): Promise<Workspace> {
  const tags = JSON.parse(await readFile(join(root, 'build', 'docker', 'images.json'), 'utf8')) as { workspace: string };
  return new Workspace({ docker, image: tags.workspace, isPortFree: platform.isPortFree, names: runtime.names, project: 'notes' });
}

async function git(...args: string[]): Promise<string> {
  return (await docker.execChecked(runtime.names.container, ['git', ...args], { user: 'node', workdir: workspaceDir('notes') })).stdout.toString('utf8').trim();
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-lost-'));
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
  await game.installEnvironment();
  await game.move(1, 'inProgress');
});

afterAll(async () => {
  await (await workspace()).destroy();
  await docker.removeVolume(runtime.names.vscodeVolume);
  await docker.removeVolume(runtime.names.cacheVolume);
  await docker.removeVolume(runtime.names.qaInputVolume);
  await rm(dir, { recursive: true, force: true });
});

describe('a workspace volume removed outside the game', () => {
  it('is noticed, blocks the code actions, and the code of every ticket is recreated', async () => {
    const before = await git('rev-parse', 'stage-1^{tree}');
    expect((await game.refreshEnvironment()).ready).toBe(true);
    expect(game.snapshot().workspaceLost).toBe(false);

    // What a Docker cleanup does: the container and the volume are gone.
    await docker.removeContainer(runtime.names.container);
    await docker.removeVolume(runtime.names.volume);

    await game.refreshEnvironment();
    expect(game.snapshot().workspaceLost).toBe(true);
    await expect(game.move(1, 'inQa')).rejects.toMatchObject({ code: 'workspaceLost' });
    await expect(game.startDevServer()).rejects.toMatchObject({ code: 'workspaceLost' });

    await game.rebuildWorkspace();
    expect(game.snapshot().workspaceLost).toBe(false);
    expect(await git('rev-parse', 'stage-1^{tree}')).toBe(before);
    expect(await git('symbolic-ref', '--short', 'HEAD')).toBe('player/ticket-1');
    expect(await git('config', '--get', 'bugdetective.game')).toBe(game.snapshot().state.createdAt);
    expect(game.snapshot().state.tickets[0].status).toBe('inProgress');

    await game.startDevServer();
    expect((await game.workspaceStatus()).devServerUp).toBe(true);
    await game.stopDevServer();
  }, 10 * 60_000);
});
