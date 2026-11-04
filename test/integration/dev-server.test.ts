/**
 * A project's dev server (the notes fixture's) in the real workspace container: "Start server" runs `npm run dev`,
 * "Stop server" stops it, also when the player started it in the VS Code terminal, and leaves no
 * process behind. Uses the "bugdetective-devserver-test" resource prefix, never the player's volumes.
 *
 *   pnpm run build && pnpm run test:integration -- dev-server
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
const PREFIX = 'bugdetective-devserver-test';
const platform = currentPlatform();

let dir: string;
let docker: Docker;
let runtime: DockerRuntime;
let game: Game;

async function workspace(): Promise<Workspace> {
  const tags = JSON.parse(await readFile(join(root, 'build', 'docker', 'images.json'), 'utf8')) as { workspace: string };
  return new Workspace({ docker, image: tags.workspace, isPortFree: platform.isPortFree, names: runtime.names, project: 'notes' });
}

/** The dev server's processes still running in the container (npm, concurrently, Vite, the API's node --watch). */
async function devProcesses(): Promise<string[]> {
  const result = await docker.exec(runtime.names.container, ['sh', '-c', "pgrep -af '[n]pm run dev|[c]oncurrently|[n]ode_modules/.bin/vite|[n]ode --watch' || true"], {
    user: 'node',
  });
  return result.stdout
    .toString('utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-devserver-'));
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
  // The images, the first ticket, then its dependencies (installed once the workspace exists).
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

describe('the workspace layout', () => {
  it("keeps the repository in /workspaces/<project> with the project's git identity", async () => {
    const sh = async (script: string) =>
      (await docker.execChecked(runtime.names.container, ['sh', '-c', script], { user: 'node' })).stdout.toString('utf8').trim();
    expect(await sh('test -d /workspaces/notes/.git && echo yes')).toBe('yes');
    expect(await sh('ls /workspaces')).toBe('notes');
    expect(await sh('git -C /workspaces/notes config user.name')).toBe('Notes Developer');
    expect(await sh('git -C /workspaces/notes config user.email')).toBe('developer@notes.invalid');
    expect(await sh('stat -c %U /workspaces /workspaces/notes')).toBe('node\nnode');
  });

  it('logs the dev server to /tmp/dev-server.log', async () => {
    await game.startDevServer();
    const log = await docker.exec(runtime.names.container, ['test', '-s', '/tmp/dev-server.log'], { user: 'node' });
    expect(log.code).toBe(0);
    await game.stopDevServer();
  });
});

describe('the dev server with real Docker', () => {
  it('starts with "Start server" and stops with "Stop server", leaving no process behind', async () => {
    expect((await game.workspaceStatus()).devServerUp).toBe(false);
    await game.startDevServer();
    expect((await game.workspaceStatus()).devServerUp).toBe(true);
    expect(await devProcesses()).not.toEqual([]);

    await game.stopDevServer();
    expect((await game.workspaceStatus()).devServerUp).toBe(false);
    expect(await devProcesses()).toEqual([]);
  });

  it('stops a server the player started in the VS Code terminal', async () => {
    // Like the VS Code terminal: npm run dev in the workspace, outside the app's own start.
    await docker.execChecked(runtime.names.container, ['sh', '-c', 'nohup npm run dev > /tmp/terminal-dev.log 2>&1 &'], {
      user: 'node',
      workdir: workspaceDir('notes'),
    });
    await expect.poll(async () => (await game.workspaceStatus()).devServerUp, { timeout: 30_000, interval: 500 }).toBe(true);

    await game.stopDevServer();
    expect((await game.workspaceStatus()).devServerUp).toBe(false);
    expect(await devProcesses()).toEqual([]);
  });

  it('stopping a server that is not running does nothing and does not fail', async () => {
    await game.stopDevServer();
    expect((await game.workspaceStatus()).devServerUp).toBe(false);
  });
});
