/**
 * The services of a project with real Docker: the notes fixture declaring a PostgreSQL. The
 * service runs next to the workspace on the internal network, the workspace gets its address in
 * a variable, the data survives closing the app, and removing the project leaves nothing behind,
 * not even the image when the app pulled it. The "bugdetective-services-test" prefix.
 *
 *   pnpm run build && pnpm run test:integration
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SERVICE_IMAGES } from '@bug-detective/catalog/contract';
import { Game } from '../../src/main/game.ts';
import { currentPlatform } from '../../src/main/platform/index.ts';
import { DockerRuntime } from '../../src/main/runtime.ts';
import { LocalContentSource } from '../../src/main/services/content/local.ts';
import { PackageStore } from '../../src/main/services/content/store.ts';
import { Docker } from '../../src/main/services/docker.ts';
import { runCommand } from '../../src/main/services/process.ts';
import { ReviewStore } from '../../src/main/services/review/store.ts';
import { StateStore } from '../../src/main/services/state.ts';
import { Workspace, networkName } from '../../src/main/services/workspace.ts';
import { createNotesProject } from '../helpers/notes-project.ts';

const root = resolve(import.meta.dirname, '..', '..');
const PREFIX = 'bugdetective-services-test';
const platform = currentPlatform();
const REFERENCE = SERVICE_IMAGES['postgres:17']!.reference;
const SERVICE = `${PREFIX}-svc-notes-db`;
const DATA = `${PREFIX}-svcdata-notes-db-0`;
const NETWORK = networkName(PREFIX, 'notes');
const services = {
  db: { image: 'postgres:17', memory: '256m', env: { POSTGRES_PASSWORD: 'notes' }, variables: { DATABASE_URL: 'postgres://postgres:notes@{{host}}:{{port}}/postgres' } },
};

let dir: string;
let qaDir: string;
let docker: Docker;
let runtime: DockerRuntime;
let game: Game;
/** The computer already had the image: then it is the player's and the app must leave it. */
let hadImage = false;
let imagesFile: string;

const text = async (args: string[]): Promise<string> => (await docker.run(args)).stdout.toString('utf8').trim();
const psql = (sql: string) => docker.exec(SERVICE, ['psql', '-U', 'postgres', '-tAc', sql]);

async function workspace(): Promise<Workspace> {
  const tags = JSON.parse(await readFile(join(root, 'build', 'docker', 'images.json'), 'utf8')) as { workspace: string };
  return new Workspace({ docker, image: tags.workspace, isPortFree: platform.isPortFree, names: runtime.names, project: 'notes' });
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

/** Everything of this test that Docker still holds, by the project label and by name. */
async function leftovers(): Promise<string[]> {
  const found = await docker.ofProject('notes');
  return [...found.containers, ...found.volumes, ...found.networks].filter((name) => name.startsWith(PREFIX));
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-services-'));
  qaDir = (await createNotesProject(join(dir, 'project'))).qaDir;
  const file = join(qaDir, 'package.json');
  const json = JSON.parse(await readFile(file, 'utf8'));
  json.bugDetective.project.services = services;
  await writeFile(file, `${JSON.stringify(json, null, 2)}\n`);
  execFileSync('git', ['commit', '-q', '-am', 'Declare the database'], { cwd: qaDir });

  const { cli } = await platform.locateDocker();
  if (!cli) throw new Error('The docker CLI was not found');
  docker = new Docker(cli, runCommand);
  hadImage = await docker.imageExists(REFERENCE);
  imagesFile = join(dir, 'service-images.json');
  runtime = new DockerRuntime(platform, {
    contextRoot: join(root, 'build', 'docker'),
    qaBuildRoot: join(root, 'build', 'qa-contexts'),
    prefix: PREFIX,
    serviceImagesFile: imagesFile,
  });
  await (await workspace()).destroy();
  game = newGame();
  await game.init();
  await game.installEnvironment();
  await game.nextAssignment();
  await game.installEnvironment();
});

afterAll(async () => {
  await docker.removeContainer(SERVICE);
  await (await workspace()).destroy();
  for (const volume of [DATA, runtime.names.vscodeVolume, runtime.names.cacheVolume, runtime.names.qaInputVolume]) {
    await docker.removeVolume(volume).catch(() => {});
  }
  await docker.removeContainer(`${PREFIX}-forward-notes`);
  await docker.removeNetwork(NETWORK).catch(() => {});
  // The image goes only when this test brought it.
  if (!hadImage && (await docker.imageExists(REFERENCE))) {
    await docker.removeImage(REFERENCE, { force: true }).catch(() => {});
  }
  await rm(dir, { recursive: true, force: true });
});

describe("a project's services with real Docker", () => {
  it('runs the service on the internal network only, with a named volume and no published port', async () => {
    const info = await docker.inspectContainer(SERVICE);
    expect(info?.running).toBe(true);
    expect(info?.networks).toEqual([NETWORK]);
    expect(info?.ports).toEqual({});
    expect(info?.image).toBe(REFERENCE);
    expect(await text(['container', 'inspect', '--format', '{{range .Mounts}}{{.Type}}:{{.Name}} {{end}}', SERVICE])).toBe(`volume:${DATA}`);
    expect(await text(['container', 'inspect', '--format', '{{.HostConfig.RestartPolicy.Name}}', SERVICE])).toMatch(/^(no)?$/);
    expect(game.snapshot().services).toEqual([{ name: 'db', image: 'postgres:17', state: 'ready' }]);
  });

  it("gives the workspace the service's address, and the workspace reaches it", async () => {
    const container = runtime.names.container;
    expect((await docker.exec(container, ['printenv', 'DATABASE_URL'], { user: 'node' })).stdout.toString('utf8').trim()).toBe(
      'postgres://postgres:notes@db:5432/postgres',
    );
    const connect = "require('node:net').connect(5432, 'db').once('connect', () => process.exit(0)).once('error', () => process.exit(1))";
    expect((await docker.exec(container, ['node', '-e', connect], { user: 'node', timeoutMs: 30_000 })).code).toBe(0);
  });

  it('records the image as its own only when it pulled it', async () => {
    const recorded = JSON.parse(await readFile(imagesFile, 'utf8').catch(() => '{"pulled":[]}')) as { pulled: string[] };
    expect(recorded.pulled).toEqual(hadImage ? [] : [REFERENCE]);
  });

  it('keeps the data when the app closes, and starts the service again with the next action', async () => {
    expect((await psql('create table kept (id int); insert into kept values (42);')).code).toBe(0);

    await game.shutdown();
    expect((await docker.inspectContainer(SERVICE))?.running).toBe(false);
    expect((await docker.inspectContainer(runtime.names.container))?.running).toBe(false);

    game = newGame();
    await game.init();
    expect((await game.refreshEnvironment()).ready).toBe(true);
    expect((await docker.inspectContainer(SERVICE))?.running).toBe(true);
    expect((await psql('select id from kept')).stdout.toString('utf8').trim()).toBe('42');
    expect(game.snapshot().services[0]?.state).toBe('ready');
  });

  it('brings back a service that was stopped outside the app', async () => {
    await docker.run(['container', 'stop', '--time', '2', SERVICE]);
    await game.refreshEnvironment();
    expect((await docker.inspectContainer(SERVICE))?.running).toBe(true);
    expect(game.snapshot().services[0]?.state).toBe('ready');
  });

  it('removes everything of the project, and the image only when the app pulled it', async () => {
    expect(await runtime.removeProjects(['notes'])).toEqual([]);
    expect(await leftovers()).toEqual([]);
    expect(await docker.inspectContainer(SERVICE)).toBeNull();
    expect(await docker.volumeExists(DATA)).toBe(false);
    expect(await docker.imageExists(REFERENCE)).toBe(hadImage);
  });
});
