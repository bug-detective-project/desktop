import { describe, expect, it } from 'vitest';
import { Docker } from '../../src/main/services/docker.ts';
import type { RunResult } from '../../src/main/services/process.ts';

const ok = (stdout = ''): RunResult => ({ code: 0, stdout: Buffer.from(stdout), stderr: '', timedOut: false });

function fake(builderExists: boolean) {
  const calls: string[][] = [];
  const docker = new Docker('docker', async (_command, args) => {
    calls.push([...args]);
    if (args[0] === 'buildx' && args[1] === 'inspect') return builderExists ? ok('Name: x') : { ...ok(), code: 1, stderr: 'not found' };
    return ok();
  });
  return { docker, calls };
}

describe('Docker.build with the app builder', () => {
  it('creates the builder when missing, builds in it with --load and prunes its cache to 2GB', async () => {
    const { docker, calls } = fake(false);
    await docker.build('/ctx', 'img:tag', 'workspace-image', undefined, undefined, null, 'bugdetective-test');
    expect(calls).toEqual([
      ['buildx', 'inspect', 'bugdetective-test-builder'],
      ['buildx', 'create', '--name', 'bugdetective-test-builder', '--driver', 'docker-container'],
      ['buildx', 'build', '--builder', 'bugdetective-test-builder', '--load', '--progress', 'plain', '--label', 'bugdetective.role=workspace-image', '--tag', 'img:tag', '/ctx'],
      ['buildx', 'prune', '--builder', 'bugdetective-test-builder', '--force', '--keep-storage', '2GB'],
    ]);
  });

  it('reuses an existing builder and labels the image with its project', async () => {
    const { docker, calls } = fake(true);
    await docker.build('/ctx', 'qa:tag', 'qa-image', undefined, undefined, 'notes');
    expect(calls.map((args) => args.slice(0, 2))).toEqual([
      ['buildx', 'inspect'],
      ['buildx', 'build'],
      ['buildx', 'prune'],
    ]);
    expect(calls[1]).toContain('--builder');
    expect(calls[1][calls[1].indexOf('--builder') + 1]).toBe('bugdetective-builder');
    expect(calls[1]).toEqual(expect.arrayContaining(['--label', 'bugdetective.project=notes']));
  });

  it('removes the builder by name, by force', async () => {
    const { docker, calls } = fake(true);
    await docker.removeBuilder('bugdetective');
    expect(calls).toEqual([['buildx', 'rm', '--force', 'bugdetective-builder']]);
  });
});
