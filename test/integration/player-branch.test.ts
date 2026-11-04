/**
 * The player's git in the VS Code terminal may switch, rename or delete the ticket branch. QA
 * still tests the working tree (with the branch warning), and the app's own git operations
 * recreate player/ticket-N from the stage. Real Docker, the notes fixture, the
 * "bugdetective-branch-test" prefix.
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
import * as rules from '../../src/shared/kanban.ts';
import { createNotesProject } from '../helpers/notes-project.ts';

const root = resolve(import.meta.dirname, '..', '..');
const PREFIX = 'bugdetective-branch-test';
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

/** The player's git in the VS Code terminal. */
async function sh(script: string): Promise<string> {
  return (await docker.execChecked(runtime.names.container, ['sh', '-c', script], { user: 'node', workdir: DIR })).stdout.toString('utf8').trim();
}

async function submit() {
  await game.move(1, 'inQa');
  await game.waitForQa();
  return rules.findTicket(game.current, 1)!;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-branch-'));
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
}, 15 * 60_000);

afterAll(async () => {
  await (await workspace()).destroy();
  await docker.removeVolume(runtime.names.vscodeVolume);
  await docker.removeVolume(runtime.names.cacheVolume);
  await docker.removeVolume(runtime.names.qaInputVolume);
  await rm(dir, { recursive: true, force: true });
});

describe('the player branch changed in the terminal', () => {
  it('QA from another branch tests the working tree and warns about the branch', async () => {
    await sh('git switch -q -c mine');
    const ticket = await submit();
    expect(ticket.attempts).toHaveLength(1);
    expect(ticket.attempts[0]).toMatchObject({ branch: 'mine', branchWarning: true });
    expect(ticket.comments.some((comment) => comment.kind === 'branchWarning')).toBe(true);
    // The buggy stage: Gate 2 fails, the ticket is back in progress on the player's branch.
    expect(ticket.comments.at(-1)!.kind).toBe('gate2Failed');
    expect(ticket.status).toBe('inProgress');
    expect(await sh('git symbolic-ref --short HEAD')).toBe('mine');
  }, 10 * 60_000);

  it('a renamed player branch still gets QA with the warning, and resetting the ticket recreates it', async () => {
    await sh('git branch -m player/ticket-1 renamed && git switch -q renamed');
    const ticket = await submit();
    expect(ticket.attempts).toHaveLength(2);
    expect(ticket.attempts[1]).toMatchObject({ branch: 'renamed', branchWarning: true });

    const ws = await workspace();
    await ws.resetToStage(1);
    expect(await ws.currentBranch()).toBe('player/ticket-1');
    expect(await sh('git rev-parse --verify refs/heads/player/ticket-1')).toBe(await sh('git rev-parse stage-1^{commit}'));
    expect(await sh('git rev-parse --verify refs/heads/renamed')).toMatch(/^[0-9a-f]{40}$/);
  }, 10 * 60_000);

  it('a deleted player branch with a detached HEAD is recreated from the stage when the app checks it out', async () => {
    await sh('git checkout -q --detach && git branch -D player/ticket-1');
    expect((await docker.exec(runtime.names.container, ['git', 'rev-parse', '--verify', '-q', 'refs/heads/player/ticket-1'], { user: 'node', workdir: DIR })).code).not.toBe(0);

    const ws = await workspace();
    await ws.checkoutPlayerBranch(1);
    expect(await ws.currentBranch()).toBe('player/ticket-1');
    expect(await sh('git rev-parse --verify refs/heads/player/ticket-1')).toBe(await sh('git rev-parse stage-1^{commit}'));
    // The game goes on: QA runs on the recreated branch without a warning.
    const ticket = await submit();
    expect(ticket.attempts.at(-1)).toMatchObject({ branch: 'player/ticket-1', branchWarning: false });
  }, 10 * 60_000);
});
