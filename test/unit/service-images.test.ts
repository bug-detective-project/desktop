import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SERVICE_IMAGES } from '@bug-detective/catalog/contract';
import type { ProjectServices } from '@bug-detective/catalog/contract';
import { Docker } from '../../src/main/services/docker.ts';
import type { CommandRunner } from '../../src/main/services/process.ts';
import { ServiceImages } from '../../src/main/services/service-images.ts';

const REFERENCE = SERVICE_IMAGES['postgres:17']!.reference;
const services: ProjectServices = { db: { image: 'postgres:17' }, audit: { image: 'postgres:17' } };

/** A docker CLI that knows which images exist; `pullFails` and `removeFails` make those commands fail. */
function world(present: string[] = [], options: { pullFails?: boolean; removeFails?: boolean } = {}) {
  const images = new Set(present);
  const calls: string[][] = [];
  const out = (code = 0, stderr = '') => ({ code, stdout: Buffer.from(''), stderr, timedOut: false });
  const runner: CommandRunner = async (_cli, args) => {
    calls.push([...args]);
    const last = args.at(-1)!;
    if (args[0] === 'image' && args[1] === 'inspect') return out(images.has(last) ? 0 : 1);
    if (args[0] === 'pull')
      return options.pullFails ? out(1, 'toomanyrequests: rate limit') : (images.add(last), out());
    if (args[0] === 'image' && args[1] === 'rm')
      return options.removeFails ? out(1, 'image is being used') : (images.delete(last), out());
    return out();
  };
  const of = (...start: string[]) => calls.filter((call) => start.every((word, index) => call[index] === word));
  return { docker: new Docker('docker', runner), images, of };
}

let dir: string;
let file: string;
const recorded = async (): Promise<unknown> => JSON.parse(await readFile(file, 'utf8'));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-service-images-'));
  file = join(dir, 'service-images.json');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('ServiceImages', () => {
  it('pulls a missing image by its pinned reference, once, and records that the app pulled it', async () => {
    const { docker, of } = world();
    const images = new ServiceImages({ docker, file });
    expect(await images.missing(services)).toEqual([REFERENCE]);

    const lines: string[] = [];
    await images.ensure(services, (line) => lines.push(line));
    expect(of('pull')).toEqual([['pull', REFERENCE]]);
    expect(lines[0]).toBe(`» docker pull ${REFERENCE}`);
    expect(await recorded()).toEqual({ pulled: [REFERENCE] });
    expect(await images.missing(services)).toEqual([]);
  });

  it('neither pulls nor records an image the computer already had', async () => {
    const { docker, of } = world([REFERENCE]);
    const images = new ServiceImages({ docker, file });
    await images.ensure(services, () => {});
    expect(of('pull')).toHaveLength(0);
    await expect(recorded()).rejects.toThrow();
  });

  it('records nothing when the pull fails, and says why', async () => {
    const { docker } = world([], { pullFails: true });
    await expect(new ServiceImages({ docker, file }).ensure(services, () => {})).rejects.toThrow(/rate limit/);
    await expect(recorded()).rejects.toThrow();
  });

  it('removes only the images the app pulled, and forgets them', async () => {
    const other = 'redis@sha256:feed';
    const { docker, images: present, of } = world([other]);
    const images = new ServiceImages({ docker, file });
    await images.ensure(services, () => {});

    expect(await images.removePulled([])).toEqual([]);
    expect(of('image', 'rm').map((call) => call.at(-1))).toEqual([REFERENCE]);
    expect([...present]).toEqual([other]);
    expect(await recorded()).toEqual({ pulled: [] });
  });

  it('keeps the images still in use by the current project', async () => {
    const { docker, of } = world();
    const images = new ServiceImages({ docker, file });
    await images.ensure(services, () => {});
    expect(await images.removePulled([REFERENCE])).toEqual([]);
    expect(of('image', 'rm')).toHaveLength(0);
    expect(await recorded()).toEqual({ pulled: [REFERENCE] });
  });

  it('keeps on record an image it could not remove, and returns it', async () => {
    const { docker } = world([REFERENCE], { removeFails: true });
    const images = new ServiceImages({ docker, file });
    await writeFile(file, JSON.stringify({ pulled: [REFERENCE] }));
    expect(await images.removePulled([])).toEqual([REFERENCE]);
    expect(await recorded()).toEqual({ pulled: [REFERENCE] });
  });

  it('forgets a recorded image that is already gone', async () => {
    const { docker, of } = world();
    await writeFile(file, JSON.stringify({ pulled: [REFERENCE] }));
    expect(await new ServiceImages({ docker, file }).removePulled([])).toEqual([]);
    expect(of('image', 'rm')).toHaveLength(0);
    expect(await recorded()).toEqual({ pulled: [] });
  });

  it.each(['not json', '{"pulled":"x"}', '[]'])('reads a broken record (%s) as an empty one', async (content) => {
    await writeFile(file, content);
    const { docker, of } = world();
    expect(await new ServiceImages({ docker, file }).removePulled([])).toEqual([]);
    expect(of('image', 'rm')).toHaveLength(0);
  });
});
