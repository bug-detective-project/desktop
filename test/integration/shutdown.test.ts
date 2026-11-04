/**
 * Closing the app with real Docker: the workspace container stops (its volume stays) and a QA run
 * in progress is recorded as interrupted with no QA container left. The notes fixture, the
 * "bugdetective-shutdown-test" prefix.
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
import { Workspace } from '../../src/main/services/workspace.ts';
import { createNotesProject } from '../helpers/notes-project.ts';

const root = resolve(import.meta.dirname, '..', '..');
const PREFIX = 'bugdetective-shutdown-test';
const platform = currentPlatform();

let dir: string;
let qaDir: string;
let docker: Docker;
let runtime: DockerRuntime;
let game: Game;

async function workspace(): Promise<Workspace> {
  const tags = JSON.parse(await readFile(join(root, 'build', 'docker', 'images.json'), 'utf8')) as { workspace: string };
  return new Workspace({ docker, image: tags.workspace, isPortFree: platform.isPortFree, names: runtime.names, project: 'notes' });
}

async function qaContainers(): Promise<string[]> {
  const result = await docker.run(['ps', '--all', '--filter', `name=${PREFIX}-qa-`, '--format', '{{.Names}}']);
  return result.stdout.toString('utf8').split('\n').filter(Boolean);
}

function newGame(): Game {
  return new Game({
    store: new StateStore(dir),
    packages: new PackageStore(join(dir, 'packages')),
    reviews: new ReviewStore(join(dir, 'reviews')),
    content: new LocalContentSource({ qaDir, runner: runCommand }),
    runtime,
    appVersion: '0.1.0-test',
    versions: { electron: 'none', node: process.versions.node, chrome: 'none' },
  });
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-shutdown-'));
  qaDir = (await createNotesProject(join(dir, 'project'))).qaDir;
  const { cli } = await platform.locateDocker();
  if (!cli) throw new Error('The docker CLI was not found');
  docker = new Docker(cli, runCommand);
  runtime = new DockerRuntime(platform, { contextRoot: join(root, 'build', 'docker'), qaBuildRoot: join(root, 'build', 'qa-contexts'), prefix: PREFIX });
  await (await workspace()).destroy();
  game = newGame();
  await game.init();
  await game.installEnvironment();
  await game.nextAssignment();
  await game.installEnvironment();
});

afterAll(async () => {
  await (await workspace()).destroy();
  await docker.removeVolume(runtime.names.vscodeVolume);
  await docker.removeVolume(runtime.names.cacheVolume);
  await docker.removeVolume(runtime.names.qaInputVolume);
  await rm(dir, { recursive: true, force: true });
});

describe('closing the app', () => {
  it('stops the workspace container with the dev server and keeps the volume', async () => {
    await game.startDevServer();
    expect((await docker.inspectContainer(runtime.names.container))?.running).toBe(true);

    await game.shutdown();
    expect((await docker.inspectContainer(runtime.names.container))?.running).toBe(false);
    expect(await docker.volumeExists(runtime.names.volume)).toBe(true);

    // The next action of the game starts everything again.
    game = newGame();
    await game.init();
    expect((await game.refreshEnvironment()).ready).toBe(true);
    expect((await docker.inspectContainer(runtime.names.container))?.running).toBe(true);
  });

  it('records a QA run in progress as interrupted and leaves no QA container', async () => {
    await game.move(1, 'inProgress');
    const run = game.move(1, 'inQa');
    await expect.poll(() => game.snapshot().state.tickets.find((item) => item.ticket === 1)?.status, { timeout: 60_000 }).toBe('inQa');
    await run;
    // Give the QA container a moment to exist, then close the app on top of it.
    await expect.poll(() => qaContainers(), { timeout: 120_000, interval: 500 }).not.toEqual([]);

    await game.shutdown();
    expect(await qaContainers()).toEqual([]);
    expect((await docker.inspectContainer(runtime.names.container))?.running).toBe(false);

    const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as { tickets: { ticket: number; status: string; attempts: unknown[]; comments: { kind: string }[] }[] };
    const ticket = saved.tickets.find((item) => item.ticket === 1)!;
    expect(ticket.status).toBe('inProgress');
    expect(ticket.attempts).toEqual([]);
    expect(ticket.comments.at(-1)?.kind).toBe('interrupted');
  });
});
