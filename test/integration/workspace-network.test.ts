/**
 * The workspace's network with real Docker: closed by default (no internet, no computer), the app
 * still reachable on its published ports through the forwarder, opened and closed by the game
 * without restarting anything. The notes fixture, the "bugdetective-network-test" prefix.
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
import { Workspace, forwarderName, networkName, workspaceDir } from '../../src/main/services/workspace.ts';
import { createNotesProject } from '../helpers/notes-project.ts';

const root = resolve(import.meta.dirname, '..', '..');
const PREFIX = 'bugdetective-network-test';
const platform = currentPlatform();

let dir: string;
let docker: Docker;
let runtime: DockerRuntime;
let game: Game;

async function workspace(): Promise<Workspace> {
  const tags = JSON.parse(await readFile(join(root, 'build', 'docker', 'images.json'), 'utf8')) as { workspace: string };
  return new Workspace({ docker, image: tags.workspace, isPortFree: platform.isPortFree, names: runtime.names, project: 'notes' });
}

/** The HTTP status a URL answers inside the workspace, or 000 when it cannot be reached. */
async function statusFromInside(url: string): Promise<string> {
  const result = await docker.exec(runtime.names.container, ['curl', '-s', '-o', '/dev/null', '-m', '6', '-w', '%{http_code}', url], { user: 'node', workdir: workspaceDir('notes'), timeoutMs: 20_000 });
  return result.stdout.toString('utf8').trim() || '000';
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-network-'));
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
  await docker.removeBuilder(PREFIX);
  await rm(dir, { recursive: true, force: true });
});

describe('the workspace network', () => {
  it('is closed by default, the app answers through the forwarder, and the game opens and closes it', async () => {
    const info = (await docker.inspectContainer(runtime.names.container))!;
    expect(info.networks).toEqual([networkName(PREFIX, 'notes')]);
    expect(info.ports).toEqual({});
    const forwarder = (await docker.inspectContainer(forwarderName(PREFIX, 'notes')))!;
    expect(forwarder.networks.sort()).toEqual(['bridge', networkName(PREFIX, 'notes')].sort());
    expect(forwarder.running).toBe(true);

    expect(await statusFromInside('https://example.com/')).toBe('000');
    expect(await statusFromInside('http://host.docker.internal/')).toBe('000');

    await game.startDevServer();
    const { ports, devServerUp } = await game.workspaceStatus();
    expect(devServerUp).toBe(true);
    await expect.poll(async () => (await fetch(`http://127.0.0.1:${ports!.client}/`).catch(() => null))?.status ?? 0, { timeout: 30_000 }).toBe(200);

    await game.setWorkspaceInternet(true);
    expect((await docker.inspectContainer(runtime.names.container))!.networks).toContain('bridge');
    expect(await runtime.workspaceInternet()).toBe(true);
    // No restart: the dev server keeps answering.
    expect((await game.workspaceStatus()).devServerUp).toBe(true);
    // The route out exists (the runner may still have no internet: the network is what is checked).
    const route = await docker.exec(runtime.names.container, ['sh', '-c', 'ip route 2>/dev/null | grep -c default || grep -c 00000000 /proc/net/route'], { user: 'node' });
    expect(route.stdout.toString('utf8').trim()).not.toBe('0');

    await game.setWorkspaceInternet(false);
    expect((await docker.inspectContainer(runtime.names.container))!.networks).toEqual([networkName(PREFIX, 'notes')]);
    expect(await statusFromInside('https://example.com/')).toBe('000');
    await game.stopDevServer();
  }, 10 * 60_000);

  it('survives the workspace being recreated: same ports, closed again', async () => {
    const before = (await game.workspaceStatus()).ports;
    await game.setWorkspaceInternet(true);
    await docker.removeContainer(runtime.names.container);
    await game.startDevServer();
    await game.refreshEnvironment();
    expect(game.snapshot().workspaceInternet).toBe(false);
    expect((await game.workspaceStatus()).ports).toEqual(before);
    await expect.poll(async () => (await fetch(`http://127.0.0.1:${before!.client}/`).catch(() => null))?.status ?? 0, { timeout: 30_000 }).toBe(200);
    await game.stopDevServer();
  }, 5 * 60_000);

  it('stops the forwarder with the workspace when the app quits, closed', async () => {
    await game.setWorkspaceInternet(true);
    await game.shutdown();
    expect((await docker.inspectContainer(runtime.names.container))!.running).toBe(false);
    expect((await docker.inspectContainer(runtime.names.container))!.networks).not.toContain('bridge');
    expect((await docker.inspectContainer(forwarderName(PREFIX, 'notes')))!.running).toBe(false);
  }, 2 * 60_000);
});
