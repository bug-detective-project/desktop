import { describe, expect, it } from 'vitest';
import type { Platform } from '../../src/main/platform/types.ts';
import { DockerRuntime } from '../../src/main/runtime.ts';
import { Docker, PROJECT_LABEL } from '../../src/main/services/docker.ts';
import type { CommandRunner } from '../../src/main/services/process.ts';

/** A docker CLI that records every command and answers from a small in-memory world. */
function recordingDocker(world: { containers: Record<string, string>; volumes: Record<string, string>; images: Record<string, string> }) {
  const calls: string[][] = [];
  const out = (text: string) => ({ code: 0, stdout: Buffer.from(text), stderr: '', timedOut: false });
  const runner: CommandRunner = async (_cli, args) => {
    calls.push([...args]);
    const project = /label=bugdetective\.project=([a-z0-9-]+)/.exec(args.join(' '))?.[1];
    const of = (items: Record<string, string>) => Object.entries(items).filter(([, p]) => p === project).map(([name]) => name);
    if (args[0] === 'container' && args[1] === 'ls') return out(of(world.containers).join('\n'));
    if (args[0] === 'volume' && args[1] === 'ls') return out(of(world.volumes).join('\n'));
    if (args[0] === 'image' && args[1] === 'ls') return out(of(world.images).map((ref) => `${ref}|sha256:${ref.length}`).join('\n'));
    if (args[0] === 'container' && args[1] === 'rm') delete world.containers[args.at(-1)!];
    if (args[0] === 'volume' && args[1] === 'rm') delete world.volumes[args.at(-1)!];
    if (args[0] === 'image' && args[1] === 'rm') delete world.images[args.at(-1)!];
    if (args[0] === 'volume' && args[1] === 'inspect') return { ...out(''), code: args[2] in world.volumes ? 0 : 1 };
    return out('');
  };
  return { docker: new Docker('docker', runner), calls };
}

describe('project labels', () => {
  it('labels a volume with its project', async () => {
    const { docker, calls } = recordingDocker({ containers: {}, volumes: {}, images: {} });
    await docker.createVolume('bugdetective-workspace', 'workspace', 'supportdesk');
    expect(calls.at(-1)).toEqual(['volume', 'create', '--label', 'bugdetective.role=workspace', '--label', `${PROJECT_LABEL}=supportdesk`, 'bugdetective-workspace']);
  });

  it('lists the containers, volumes and images of one project', async () => {
    const { docker } = recordingDocker({
      containers: { 'bugdetective-workspace': 'old' },
      volumes: { 'bugdetective-workspace': 'old', 'bugdetective-qa-cache': 'old', 'bugdetective-other': 'new' },
      images: { 'bugdetective-qa:abc': 'old' },
    });
    const found = await docker.ofProject('old');
    expect(found.containers).toEqual(['bugdetective-workspace']);
    expect(found.volumes.sort()).toEqual(['bugdetective-qa-cache', 'bugdetective-workspace']);
    expect(found.images.map((image) => image.ref)).toEqual(['bugdetective-qa:abc']);
  });
});

describe('removing other projects from Docker', () => {
  const runtimeWith = (docker: Docker) => {
    const runtime = new DockerRuntime({ dockerHostPath: (path: string) => path } as unknown as Platform, { contextRoot: '/nowhere', qaBuildRoot: '/nowhere/qa' });
    (runtime as unknown as Record<string, unknown>).docker = async () => docker;
    return runtime;
  };

  it('removes every resource of the given projects, containers first, and reports nothing left', async () => {
    const world = {
      containers: { 'bugdetective-workspace': 'old', 'bugdetective-qa-1': 'old' },
      volumes: { 'bugdetective-workspace': 'old', 'bugdetective-qa-cache': 'old', 'bugdetective-keep': 'current' },
      images: { 'bugdetective-qa:abc': 'old' },
    };
    const { docker, calls } = recordingDocker(world);
    const left = await runtimeWith(docker).removeProjects(['old']);
    expect(left).toEqual([]);
    expect(world.volumes).toEqual({ 'bugdetective-keep': 'current' });
    const removals = calls.filter((call) => call[1] === 'rm').map((call) => call[0]);
    expect(removals.indexOf('volume')).toBeGreaterThan(removals.lastIndexOf('container'));
  });

  it('reports what is still there when a removal fails', async () => {
    const world = { containers: {}, volumes: { 'bugdetective-workspace': 'old' }, images: {} };
    const { docker } = recordingDocker(world);
    const stubborn = Object.assign(Object.create(docker), { removeVolume: async () => {} }) as Docker;
    expect(await runtimeWith(stubborn).removeProjects(['old'])).toEqual([{ kind: 'volume', name: 'bugdetective-workspace' }]);
  });
});
