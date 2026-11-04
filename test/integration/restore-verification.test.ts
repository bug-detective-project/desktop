/**
 * A restored save is checked against the publication, with real Docker: the stage tags of the
 * bundle are replaced by the verified ticket code, so a save whose stage-1 points at other code
 * (what a shared, forged save would do) ends with the published code under "Restart the ticket".
 * The notes fixture, the "bugdetective-restore-test" prefix.
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
const PREFIX = 'bugdetective-restore-test';
const platform = currentPlatform();

let dir: string;
let docker: Docker;
let runtime: DockerRuntime;
let game: Game;

async function workspace(): Promise<Workspace> {
  const tags = JSON.parse(await readFile(join(root, 'build', 'docker', 'images.json'), 'utf8')) as { workspace: string };
  return new Workspace({ docker, image: tags.workspace, isPortFree: platform.isPortFree, names: runtime.names, project: 'notes' });
}

async function sh(script: string): Promise<string> {
  return (await docker.execChecked(runtime.names.container, ['sh', '-c', script], { user: 'node', workdir: workspaceDir('notes') })).stdout.toString('utf8').trim();
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-restore-'));
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
    installKey: new Uint8Array(Buffer.from('11'.repeat(32), 'hex')),
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

describe('a restored save with a forged stage tag', () => {
  it('gets the published code back under its stage tag, and the state points at that commit', async () => {
    const published = await sh('git rev-parse stage-1^{tree}');
    // What a forged save carries: stage-1 moved to a commit with other code (the player's branch itself stays as it was).
    await sh("git checkout -q -b forged stage-1 && echo evil > evil.txt && git add evil.txt && git -c user.name=x -c user.email=x@x commit -q -m evil && git tag -f stage-1 HEAD >/dev/null && git checkout -q player/ticket-1 && git branch -q -D forged");
    expect(await sh('git rev-parse stage-1^{tree}')).not.toBe(published);
    const file = join(dir, 'forged.bdsave');
    await game.exportProgress(file);

    const { token, summary } = await game.inspectSave(file, 'forged.bdsave');
    expect(summary.fromThisInstall).toBe(true);
    await game.restoreProgress(token);

    expect(await sh('git rev-parse stage-1^{tree}')).toBe(published);
    expect(game.snapshot().state.tickets[0].stageCommit).toBe(await sh('git rev-parse stage-1'));
    expect(await sh('git symbolic-ref --short HEAD')).toBe('player/ticket-1');
    // "Restart the ticket" (the reset to the stage) lands on the published code, not on the forged one.
    await runtime.resetToStage(1);
    expect(await sh('git rev-parse HEAD^{tree}')).toBe(published);
    expect(await sh('test -e evil.txt && echo present || echo absent')).toBe('absent');
    expect(game.snapshot().log.join('\n')).toContain('» Verified the code of ticket 1 (front-1)');
  }, 10 * 60_000);
});
