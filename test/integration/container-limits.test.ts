/**
 * The limits and the hardening of the containers, with real Docker: raw containers from the
 * workspace image, run with the same arguments the app uses (limitArgs), under the
 * "bugdetective-limits-test" prefix. The game itself keeps working with them: qa-flow.test.ts.
 *
 *   pnpm run build && pnpm run test:integration
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentPlatform } from '../../src/main/platform/index.ts';
import { Docker, labelArgs } from '../../src/main/services/docker.ts';
import { QA_LIMITS, WORKSPACE_LIMITS, limitArgs } from '../../src/main/services/limits.ts';
import { runCommand } from '../../src/main/services/process.ts';

const root = resolve(import.meta.dirname, '..', '..');
const PREFIX = 'bugdetective-limits-test';
const platform = currentPlatform();
let docker: Docker;
let image: string;
const names: string[] = [];

/** Runs a raw container (no --rm, so it can be inspected) and returns the result plus its name. */
async function raw(limits: typeof WORKSPACE_LIMITS, command: string[], timeoutMs = 120_000) {
  const name = `${PREFIX}-${names.length + 1}`;
  names.push(name);
  const result = await docker.run(
    ['run', '--name', name, ...labelArgs('workspace', null), '--init', ...limitArgs(limits), '--network', 'none', '--entrypoint', command[0], image, ...command.slice(1)],
    { timeoutMs },
  );
  return { ...result, name, text: result.stdout.toString('utf8') };
}

beforeAll(async () => {
  const { cli } = await platform.locateDocker();
  if (!cli) throw new Error('The docker CLI was not found');
  docker = new Docker(cli, runCommand);
  image = (JSON.parse(await readFile(join(root, 'build', 'docker', 'images.json'), 'utf8')) as { workspace: string }).workspace;
  if (!(await docker.imageExists(image))) throw new Error(`The workspace image ${image} is not built: run pnpm run prepare:resources`);
});

afterAll(async () => {
  for (const name of names) await docker.removeContainer(name);
});

describe('container limits and hardening', () => {
  it('kills a process that exceeds the memory limit (exit 137, OOMKilled) instead of the computer', async () => {
    const run = await raw(QA_LIMITS, ['node', '-e', 'const a=[];for(;;)a.push(Buffer.alloc(1e8).fill(1))']);
    expect(run.code).toBe(137);
    expect(await docker.oomKilled(run.name)).toBe(true);
  });

  it('stops a fork bomb at the pids limit and Docker keeps answering', async () => {
    const run = await raw(WORKSPACE_LIMITS, ['sh', '-c', 'f(){ f|f& }; f; sleep 5; echo survived'], 60_000);
    expect(run.timedOut).toBe(false);
    const inspected = await docker.run(['container', 'inspect', '--format', '{{.HostConfig.PidsLimit}}', run.name]);
    expect(inspected.stdout.toString('utf8').trim()).toBe(String(WORKSPACE_LIMITS.pids));
    expect(await docker.serverVersion()).not.toBeNull();
  });

  it.each([
    ['workspace', WORKSPACE_LIMITS],
    ['QA', QA_LIMITS],
  ])('runs the %s container without capabilities and without a way to gain them', async (_kind, limits) => {
    const run = await raw(limits, ['sh', '-c', "grep -E 'NoNewPrivs|CapEff' /proc/self/status; id -u"]);
    expect(run.code).toBe(0);
    expect(run.text).toMatch(/NoNewPrivs:\s+1/);
    expect(run.text).toMatch(/CapEff:\s+0000000000000000/);
    expect(run.text.trim().split('\n').at(-1)).toBe('1000');
  });
});
