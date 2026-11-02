/**
 * Switching projects with real Docker and git: two small test projects (switch-a with one front
 * ticket, switch-b with one front and one back). Finishing switch-a's only ticket completes the
 * project; switching to switch-b must leave no container, volume or image of switch-a in Docker,
 * and coming back restores switch-a's progress and PRs. QA only copies the workspace and passes.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Game } from '../../src/main/game.ts';
import { currentPlatform } from '../../src/main/platform/index.ts';
import { DockerRuntime } from '../../src/main/runtime.ts';
import type { QaRequest } from '../../src/main/runtime.ts';
import { LocalContentSource } from '../../src/main/services/content/local.ts';
import { qaToolFiles } from '../../src/main/services/content/project-files.ts';
import { readQaFiles } from '../../src/main/services/content/publish.ts';
import { PackageStore } from '../../src/main/services/content/store.ts';
import { Docker } from '../../src/main/services/docker.ts';
import { runCommand } from '../../src/main/services/process.ts';
import type { QaRunner } from '../../src/main/services/qa.ts';
import { ReviewStore } from '../../src/main/services/review/store.ts';
import { StateStore } from '../../src/main/services/state.ts';
import { Workspace } from '../../src/main/services/workspace.ts';
import type { EnvironmentReport } from '../../src/shared/api.ts';
import type { QaResult } from '../../src/shared/types.ts';
import { createProjectRepo } from '../helpers/project-repo.ts';
import type { ProjectRepo } from '../helpers/project-repo.ts';

const root = resolve(import.meta.dirname, '..', '..');
const PREFIX = 'bugdetective-switch-test';
const platform = currentPlatform();

let tool: Awaited<ReturnType<typeof qaToolFiles>>;

/** Real Docker and git; QA copies the workspace and passes; the QA image is SupportDesk's (built by the other tests). */
class SwitchRuntime extends DockerRuntime {
  override async runQa(request: QaRequest): Promise<QaResult> {
    const qa = await (this as unknown as { qa(): Promise<QaRunner> }).qa();
    await (qa as unknown as { copyWorkspace(): Promise<void> }).copyWorkspace();
    return { ticket: request.ticket, gate: 2, status: 'passed', message: '', tests: [], durationMs: 1 };
  }
  override async openVSCodeReview() {}
  override async resetDatabase() {}
  override setQaTool() {
    super.setQaTool(tool);
  }
  // The test projects have no npm dependencies to install.
  override async environment(): Promise<EnvironmentReport> {
    return { items: [], ready: true };
  }
}

let dir: string;
let docker: Docker;
let runtime: SwitchRuntime;
const repos: Record<string, ProjectRepo> = {};

function game(): Game {
  const catalog = [
    { id: 'switch-a', repository: 'owner/switch-a', starter: true, version: '0.0.0' },
    { id: 'switch-b', repository: 'owner/switch-b', starter: false, version: '0.0.0' },
  ];
  return new Game({
    store: new StateStore(join(dir, 'game')),
    packages: new PackageStore(join(dir, 'game', 'projects', 'switch-a', 'packages')),
    reviews: new ReviewStore(join(dir, 'game', 'projects', 'switch-a', 'reviews')),
    content: new LocalContentSource({ qaDir: repos['switch-a'].qaDir, runner: runCommand }),
    projects: {
      catalog,
      content: (id) => new LocalContentSource({ qaDir: repos[id].qaDir, runner: runCommand }),
      packages: (id) => new PackageStore(join(dir, 'game', 'projects', id, 'packages')),
      reviews: (id) => new ReviewStore(join(dir, 'game', 'projects', id, 'reviews')),
    },
    runtime,
    appVersion: '0.1.0-test',
    versions: { electron: 'none', node: process.versions.node, chrome: 'none' },
  });
}

async function finish(play: Game, ticket: number) {
  await play.move(ticket, 'inProgress');
  await play.move(ticket, 'inQa');
  await play.waitForQa();
  const card = play.current.tickets.find((item) => item.ticket === ticket)!;
  if (card.status !== 'codeReview') {
    throw new Error(`QA did not pass: ${JSON.stringify(card.comments.at(-1))}\n${play.snapshot().log.slice(-15).join('\n')}`);
  }
  await play.acceptReview(ticket);
}

const nothingLeft = async (project: string) => {
  const found = await docker.ofProject(project);
  return [...found.containers, ...found.volumes, ...found.images.map((image) => image.ref)];
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-switch-'));
  tool = qaToolFiles(await readQaFiles(resolve(root, '..', 'supportdesk-qa'), runCommand));
  repos['switch-a'] = await createProjectRepo(join(dir, 'repos'), { front: 1, back: 0 }, 'Switch A', 'switch-a');
  repos['switch-b'] = await createProjectRepo(join(dir, 'repos'), { front: 1, back: 1 }, 'Switch B', 'switch-b');
  const { cli } = await platform.locateDocker();
  if (!cli) throw new Error('The docker CLI was not found');
  docker = new Docker(cli, runCommand);
  runtime = new SwitchRuntime(platform, { contextRoot: join(root, 'build', 'docker'), qaBuildRoot: join(root, 'build', 'qa-contexts'), prefix: PREFIX });
});

afterAll(async () => {
  const tags = JSON.parse(await readFile(join(root, 'build', 'docker', 'images.json'), 'utf8')) as { workspace: string };
  await new Workspace({ docker, image: tags.workspace, isPortFree: platform.isPortFree, names: runtime.names }).destroy();
  await runtime.removeProjects(['switch-a', 'switch-b']);
  for (const volume of [runtime.names.vscodeVolume]) {
    await docker.removeVolume(volume);
  }
  await rm(dir, { recursive: true, force: true });
});

describe('switching projects', () => {
  it('leaves only the active project in Docker, and brings the progress back on return', async () => {
    const play = game();
    await play.init();
    await play.nextAssignment('front');
    expect((await docker.ofProject('switch-a')).volumes).toContain(runtime.names.volume);
    await finish(play, 1);
    expect(play.snapshot().projectsUnlocked).toBe(true);

    await play.switchProject('switch-b');
    expect(await nothingLeft('switch-a')).toEqual([]);
    expect(play.current).toMatchObject({ project: 'switch-b', projectSwitch: null });
    await play.nextAssignment('back');
    expect(play.current.tickets[0]).toMatchObject({ id: 'back-1' });
    expect((await docker.ofProject('switch-b')).volumes).toContain(runtime.names.volume);
    await finish(play, 1);

    await play.switchProject('switch-a');
    expect(await nothingLeft('switch-b')).toEqual([]);
    expect(play.current.project).toBe('switch-a');
    expect(play.current.tickets.map((ticket) => [ticket.id, ticket.status])).toEqual([['front-1', 'done']]);
    // The PR of before the switch is still reviewable in the app, from its stored diffs.
    expect(await play.reviewComparison(1)).toBeTruthy();
    // Its code is not in this workspace any more, so it cannot be opened in VS Code.
    await expect(play.openReview(1)).rejects.toMatchObject({ code: 'reviewUnavailable' });
  });
});
