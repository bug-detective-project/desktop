/**
 * Docker cleanup with real Docker: "Clean up leftovers" and "Remove everything".
 * Runs in its own namespace: the "bugdetective-cleanup-test" prefix and image repositories of its
 * own (tags of the workspace image), so the player's and the developer's resources stay.
 *
 *   pnpm run build && pnpm run test:integration
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentPlatform } from '../../src/main/platform/index.ts';
import { DockerRuntime } from '../../src/main/runtime.ts';
import { Docker, LABEL } from '../../src/main/services/docker.ts';
import { runCommand } from '../../src/main/services/process.ts';
import { textFile } from '@bug-detective/catalog/contract';
import { qaImageTag } from '../../src/main/services/qa-image.ts';

const root = resolve(import.meta.dirname, '..', '..');
const PREFIX = 'bugdetective-cleanup-test';
// The QA image tag comes from the docker/qa hash and the project's QA tool, in the test's repository.
const QA_TOOL = [textFile('run.ts', 'cleanup test\n')];
const IMAGES = {
  workspace: `${PREFIX}-workspace-image:current`,
  qa: qaImageTag('cleanup-test', QA_TOOL, `${PREFIX}-qa-image`),
  old: `${PREFIX}-workspace-image:old`,
};
const platform = currentPlatform();
let dir: string;
let docker: Docker;
let runtime: DockerRuntime;

const exists = {
  container: async (name: string) => (await docker.inspectContainer(name)) !== null,
  volume: (name: string) => docker.volumeExists(name),
  image: (ref: string) => docker.imageExists(ref),
};

async function removeEverythingOfTheTest() {
  for (const container of [`${PREFIX}-workspace`, `${PREFIX}-qa-0001`]) {
    await docker.removeContainer(container);
  }
  for (const volume of [`${PREFIX}-workspace`, `${PREFIX}-qa-input`]) {
    await docker.removeVolume(volume).catch(() => {});
  }
  for (const image of Object.values(IMAGES)) {
    await docker.run(['image', 'rm', image]);
  }
}

beforeAll(async () => {
  const { cli } = await platform.locateDocker();
  if (!cli) throw new Error('The docker CLI was not found');
  docker = new Docker(cli, runCommand);
  // The test's own image tags, made from the (labelled) workspace image built by the other tests.
  const built = JSON.parse(await readFile(join(root, 'build', 'docker', 'images.json'), 'utf8')) as { workspace: string };
  dir = await mkdtemp(join(tmpdir(), 'bd-cleanup-'));
  await writeFile(join(dir, 'images.json'), JSON.stringify({ workspace: IMAGES.workspace, qaBase: 'cleanup-test' }));
  runtime = new DockerRuntime(platform, { contextRoot: dir, qaBuildRoot: join(dir, 'qa'), qaRepository: `${PREFIX}-qa-image`, prefix: PREFIX });
  runtime.setQaTool(QA_TOOL);
  await removeEverythingOfTheTest();
  for (const image of Object.values(IMAGES)) {
    await docker.checked(['image', 'tag', built.workspace, image]);
  }
  await docker.createVolume(`${PREFIX}-workspace`, 'workspace');
  await docker.createVolume(`${PREFIX}-qa-input`, 'qa-input');
  for (const [name, role] of [
    [`${PREFIX}-workspace`, 'workspace'],
    [`${PREFIX}-qa-0001`, 'qa'],
  ]) {
    await docker.checked(['container', 'create', '--name', name, '--label', `${LABEL}=${role}`, IMAGES.workspace, 'true']);
  }
});

afterAll(async () => {
  await removeEverythingOfTheTest();
  await rm(dir, { recursive: true, force: true });
});

describe('Docker cleanup', () => {
  it('leftovers: removes the QA container, the QA input volume and the old image; the workspace stays', async () => {
    const result = await runtime.cleanDocker('leftovers');
    expect(result).toEqual({ removed: 3, failed: [] });
    expect(await exists.container(`${PREFIX}-qa-0001`)).toBe(false);
    expect(await exists.volume(`${PREFIX}-qa-input`)).toBe(false);
    expect(await exists.image(IMAGES.old)).toBe(false);
    // The player's work and the current images stay.
    expect(await exists.container(`${PREFIX}-workspace`)).toBe(true);
    expect(await exists.volume(`${PREFIX}-workspace`)).toBe(true);
    expect(await exists.image(IMAGES.workspace)).toBe(true);
    expect(await exists.image(IMAGES.qa)).toBe(true);
  });

  it('everything: removes the workspace container and volume and the current images', async () => {
    const result = await runtime.cleanDocker('everything');
    expect(result.failed).toEqual([]);
    expect(result.workspaceKept).toBe(false);
    expect(await exists.container(`${PREFIX}-workspace`)).toBe(false);
    expect(await exists.volume(`${PREFIX}-workspace`)).toBe(false);
    expect(await exists.image(IMAGES.workspace)).toBe(false);
    expect(await exists.image(IMAGES.qa)).toBe(false);
    // Another namespace (the image the tags were made from) is untouched.
    const built = JSON.parse(await readFile(join(root, 'build', 'docker', 'images.json'), 'utf8')) as { workspace: string };
    expect(await exists.image(built.workspace)).toBe(true);
  });
});
