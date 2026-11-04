/**
 * The app's own BuildKit builder with real Docker: created on demand, the images built in it and
 * its cache kept small, Docker's global build cache untouched, and removed with the app's data.
 * The "bugdetective-builder-test" prefix; the workspace build context from build/docker/.
 *
 *   pnpm run build && pnpm run test:integration
 */
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { currentPlatform } from '../../src/main/platform/index.ts';
import { Docker } from '../../src/main/services/docker.ts';
import { runCommand } from '../../src/main/services/process.ts';

const root = resolve(import.meta.dirname, '..', '..');
const PREFIX = 'bugdetective-builder-test';
const IMAGE = `${PREFIX}-workspace-image:builder`;
const platform = currentPlatform();
let docker: Docker;

/** "1.234GB", "512.3MB", "0B" → bytes. */
function bytes(size: string): number {
  const match = /^([\d.]+)\s*([KMGT]?i?B)$/i.exec(size.trim());
  if (!match) throw new Error(`Unexpected size: ${size}`);
  const unit = match[2].toUpperCase()[0];
  const factor = unit === 'K' ? 1e3 : unit === 'M' ? 1e6 : unit === 'G' ? 1e9 : unit === 'T' ? 1e12 : 1;
  return Number(match[1]) * factor;
}

/** Docker's global build cache size, from `docker system df`. */
async function globalBuildCache(): Promise<number> {
  const result = await docker.checked(['system', 'df', '--format', '{{.Type}}\t{{.Size}}']);
  const line = result.stdout.toString('utf8').split('\n').find((item) => item.startsWith('Build Cache'));
  return line ? bytes(line.split('\t')[1]) : 0;
}

async function builderExists(): Promise<boolean> {
  return (await docker.run(['buildx', 'inspect', Docker.builderName(PREFIX)])).code === 0;
}

beforeAll(async () => {
  const { cli } = await platform.locateDocker();
  if (!cli) throw new Error('The docker CLI was not found');
  docker = new Docker(cli, runCommand);
  await docker.removeBuilder(PREFIX);
});

afterAll(async () => {
  await docker.removeBuilder(PREFIX);
  await docker.run(['image', 'rm', IMAGE]);
});

describe('the app builder', () => {
  it('is created on demand, builds the workspace image, keeps its cache under 2.5 GB and leaves the global build cache alone', async () => {
    expect(await builderExists()).toBe(false);
    const before = await globalBuildCache();

    await docker.build(platform.dockerHostPath(join(root, 'build', 'docker', 'workspace')), IMAGE, 'workspace-image', undefined, undefined, null, PREFIX);

    expect(await builderExists()).toBe(true);
    expect(await docker.imageExists(IMAGE)).toBe(true);
    const du = (await docker.checked(['buildx', 'du', '--builder', Docker.builderName(PREFIX)])).stdout.toString('utf8');
    const total = /Total:\s+(\S+)/.exec(du)?.[1];
    expect(total, du).toBeDefined();
    expect(bytes(total!)).toBeLessThan(2.5e9);
    expect(Math.abs((await globalBuildCache()) - before)).toBeLessThan(1e6);
  }, 20 * 60_000);

  it('is removed with its cache', async () => {
    await docker.removeBuilder(PREFIX);
    expect(await builderExists()).toBe(false);
  });
});
