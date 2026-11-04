/**
 * The dependency cache volume is read-only for QA test runs and writable only for the dependency
 * preparation, with the app's own container arguments on real Docker (the workspace image stands
 * in for the QA image: only the mounts matter here). The "bugdetective-qacache-test" prefix.
 *
 *   pnpm run build && pnpm run test:integration
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentPlatform } from '../../src/main/platform/index.ts';
import { Docker } from '../../src/main/services/docker.ts';
import { runCommand } from '../../src/main/services/process.ts';
import { QaRunner } from '../../src/main/services/qa.ts';
import { resourceNames } from '../../src/main/services/workspace.ts';

const root = resolve(import.meta.dirname, '..', '..');
const names = resourceNames('bugdetective-qacache-test');
const platform = currentPlatform();
let docker: Docker;
let image: string;
let qa: QaRunner;
const containers: string[] = [];

async function raw(network: boolean, script: string) {
  const name = `${names.prefix}-qa-${containers.length + 1}`;
  containers.push(name);
  return docker.run([...qa.containerArgs(name, { network }), '--entrypoint', 'sh', image, '-c', script], { timeoutMs: 60_000 });
}

beforeAll(async () => {
  const { cli } = await platform.locateDocker();
  if (!cli) throw new Error('The docker CLI was not found');
  docker = new Docker(cli, runCommand);
  image = (JSON.parse(await readFile(join(root, 'build', 'docker', 'images.json'), 'utf8')) as { workspace: string }).workspace;
  qa = new QaRunner({ docker, image, dockerHostPath: (path) => path, names, project: 'notes' });
  await docker.createVolume(names.volume, 'workspace', 'notes');
  await docker.createVolume(names.cacheVolume, 'qa-cache', 'notes');
  // The QA image hands /cache to node on the volume's first mount; the workspace image stands in here, so do it by hand.
  await docker.checked(['run', '--rm', '--user', 'root', '--mount', `type=volume,src=${names.cacheVolume},dst=/cache`, '--entrypoint', 'chown', image, 'node:node', '/cache']);
});

afterAll(async () => {
  for (const name of containers) await docker.removeContainer(name);
  await docker.removeVolume(names.volume);
  await docker.removeVolume(names.cacheVolume);
});

describe('the dependency cache in QA containers', () => {
  it('cannot be written by a test run (no network)', async () => {
    const run = await raw(false, 'touch /cache/planted');
    expect(run.code).not.toBe(0);
    expect(run.stderr).toMatch(/[Rr]ead-only file system/);
  });

  it('is written by the dependency preparation (with network), and the workspace stays read-only', async () => {
    const run = await raw(true, 'mkdir -p /cache/deps && touch /cache/deps/x && ! touch /workspace/y && echo ok');
    expect(run.stdout.toString('utf8').trim()).toBe('ok');
    expect(run.code).toBe(0);
  });
});
