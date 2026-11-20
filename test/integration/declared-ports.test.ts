/**
 * The ports a project declares, with real Docker: the forwarder publishes each one on the computer
 * and the workspace mirrors it, so a server on localhost and one on 0.0.0.0 both answer; the ports'
 * variables carry the ports chosen. The "bugdetective-ports-test" prefix; no game, no project image.
 *
 *   pnpm run build && pnpm run test:integration
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { ProjectPorts } from '@bug-detective/catalog/contract';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentPlatform } from '../../src/main/platform/index.ts';
import { Docker } from '../../src/main/services/docker.ts';
import { runCommand } from '../../src/main/services/process.ts';
import { Workspace, resourceNames } from '../../src/main/services/workspace.ts';

const root = resolve(import.meta.dirname, '..', '..');
const names = resourceNames('bugdetective-ports-test');
const platform = currentPlatform();

const declared: ProjectPorts = {
  client: { port: 4100, variables: { CLIENT_ORIGIN: 'http://localhost:{{port}}' } },
  audit: { port: 4200, variables: { AUDIT_URL: 'http://localhost:{{port}}' } },
};

let docker: Docker;
let workspace: Workspace;

/** A server in the workspace that answers its own name, on the host and port given. */
function serve(name: string, host: string, port: number): Promise<unknown> {
  const script = `require('node:http').createServer((_, res) => res.end('${name}')).listen(${port}, '${host}')`;
  return docker.checked(['exec', '--detach', '--user', 'node', names.container, 'node', '-e', script]);
}

const answer = (port: number) =>
  fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) })
    .then((response) => response.text())
    .catch(() => '');

beforeAll(async () => {
  const { cli } = await platform.locateDocker();
  if (!cli) throw new Error('The docker CLI was not found');
  docker = new Docker(cli, runCommand);
  const tags = JSON.parse(await readFile(join(root, 'build', 'docker', 'images.json'), 'utf8')) as {
    workspace: string;
  };
  workspace = new Workspace({
    docker,
    image: tags.workspace,
    isPortFree: platform.isPortFree,
    names,
    project: 'notes',
    declaredPorts: declared,
  });
  await workspace.destroy();
  await workspace.ensureRunning();
});

afterAll(async () => {
  await workspace.destroy();
  await docker.removeVolume(names.vscodeVolume);
  await docker.removeVolume(names.cacheVolume);
});

describe('the declared ports', () => {
  it('a server on localhost and one on 0.0.0.0 both answer through their published ports', async () => {
    const ports = (await workspace.ports())!;
    expect(Object.keys(ports)).toEqual(['client', 'audit']);

    await serve('client', 'localhost', 4100);
    await serve('audit', '0.0.0.0', 4200);

    await expect.poll(() => answer(ports.client), { timeout: 15_000 }).toBe('client');
    await expect.poll(() => answer(ports.audit!), { timeout: 15_000 }).toBe('audit');
  });

  it('give the workspace the ports chosen on the computer', async () => {
    const ports = (await workspace.ports())!;
    const result = await docker.checked(['exec', names.container, 'printenv', 'AUDIT_URL', 'CLIENT_ORIGIN']);
    expect(result.stdout.toString('utf8').trim().split('\n')).toEqual([
      `http://localhost:${ports.audit}`,
      `http://localhost:${ports.client}`,
    ]);
  });
});
