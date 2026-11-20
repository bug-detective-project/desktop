import { describe, expect, it } from 'vitest';
import type { Platform } from '../../src/main/platform/types.ts';
import { DockerRuntime } from '../../src/main/runtime.ts';
import { Docker, PROJECT_LABEL } from '../../src/main/services/docker.ts';
import type { CommandRunner } from '../../src/main/services/process.ts';

/** A docker CLI that records every command and answers from a small in-memory world. */
function recordingDocker(world: {
  containers: Record<string, string>;
  volumes: Record<string, string>;
  images: Record<string, string>;
}) {
  const calls: string[][] = [];
  const out = (text: string) => ({ code: 0, stdout: Buffer.from(text), stderr: '', timedOut: false });
  const runner: CommandRunner = async (_cli, args) => {
    calls.push([...args]);
    const project = /label=bugdetective\.project=([a-z0-9-]+)/.exec(args.join(' '))?.[1];
    const of = (items: Record<string, string>) =>
      Object.entries(items)
        .filter(([, p]) => p === project)
        .map(([name]) => name);
    if (args[0] === 'container' && args[1] === 'ls') return out(of(world.containers).join('\n'));
    if (args[0] === 'volume' && args[1] === 'ls') return out(of(world.volumes).join('\n'));
    if (args[0] === 'image' && args[1] === 'ls')
      return out(
        of(world.images)
          .map((ref) => `${ref}|sha256:${ref.length}`)
          .join('\n'),
      );
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
    expect(calls.at(-1)).toEqual([
      'volume',
      'create',
      '--label',
      'bugdetective.role=workspace',
      '--label',
      `${PROJECT_LABEL}=supportdesk`,
      'bugdetective-workspace',
    ]);
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
    const runtime = new DockerRuntime({ dockerHostPath: (path: string) => path } as unknown as Platform, {
      contextRoot: '/nowhere',
      qaBuildRoot: '/nowhere/qa',
    });
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
    expect(await runtimeWith(stubborn).removeProjects(['old'])).toEqual([
      { kind: 'volume', name: 'bugdetective-workspace' },
    ]);
  });
});

describe("a project's services and the internet", () => {
  const services = { db: { image: 'postgres:17', env: { POSTGRES_PASSWORD: 'shop' } } };

  it('never downloads a service image, nor starts the service, outside "Download and install"', async () => {
    const { docker, calls } = recordingDocker({ containers: {}, volumes: {}, images: {} });
    const withoutImage = Object.assign(Object.create(docker), { imageExists: async () => false }) as Docker;
    const runtime = new DockerRuntime({ dockerHostPath: (path: string) => path } as unknown as Platform, {
      contextRoot: '/nowhere',
      qaBuildRoot: '/nowhere/qa',
    });
    (runtime as unknown as Record<string, unknown>).docker = async () => withoutImage;
    runtime.setProject('shop');
    runtime.setResources({ services });

    await (runtime as unknown as { ensureServices: () => Promise<void> }).ensureServices();
    expect(calls.filter((call) => call[0] === 'pull' || call[0] === 'run')).toEqual([]);
  });
});

describe("a project's declared ports", () => {
  it('reach the workspace, which publishes them', async () => {
    const { docker } = recordingDocker({ containers: {}, volumes: {}, images: {} });
    const runtime = new DockerRuntime({ dockerHostPath: (path: string) => path } as unknown as Platform, {
      contextRoot: '/nowhere',
      qaBuildRoot: '/nowhere/qa',
    });
    (runtime as unknown as Record<string, unknown>).docker = async () => docker;
    (runtime as unknown as Record<string, unknown>).imageTags = async () => ({ workspace: 'ws:test' });
    runtime.setProject('shop');
    const ports = { client: { port: 5173 }, audit: { port: 3002 } };
    runtime.setResources({ ports });

    const workspace = await (runtime as unknown as { workspace: () => Promise<object> }).workspace();
    expect((workspace as unknown as { declaredPorts: unknown }).declaredPorts).toEqual(ports);
  });
});

describe('a workspace that runs out of memory', () => {
  /** A docker CLI whose workspace container has the given state and kernel counter of processes killed for lack of memory. */
  function workspaceWith(state: { id: string; running: boolean; kills: number | null; oomKilled?: boolean }) {
    const out = (text: string, code = 0) => ({ code, stdout: Buffer.from(text), stderr: '', timedOut: false });
    const docker = new Docker('docker', async (_cli, args) => {
      if (args[0] === 'container' && args[1] === 'inspect') {
        if (args.includes('--format')) return out(String(state.oomKilled ?? false));
        return out(
          JSON.stringify([
            {
              Id: state.id,
              Name: '/bugdetective-workspace',
              State: { Running: state.running },
              Config: { Image: 'x', Labels: {} },
              HostConfig: { PortBindings: {} },
            },
          ]),
        );
      }
      if (args[0] === 'exec')
        return state.kills === null ? out('', 1) : out(`oom_kill_disable 0\nunder_oom 0\noom_kill ${state.kills}\n`);
      return out('');
    });
    const runtime = new DockerRuntime({ dockerHostPath: (path: string) => path } as unknown as Platform, {
      contextRoot: '/nowhere',
      qaBuildRoot: '/nowhere/qa',
    });
    (runtime as unknown as Record<string, unknown>).docker = async () => docker;
    return { runtime, state };
  }

  it('notices a process killed inside a workspace that stays up, once per kill', async () => {
    const { runtime, state } = workspaceWith({ id: 'a', running: true, kills: 0 });
    expect(await runtime.workspaceOutOfMemory()).toBe(false);
    state.kills = 1;
    expect(await runtime.workspaceOutOfMemory()).toBe(true);
    expect(await runtime.workspaceOutOfMemory()).toBe(false);
    state.kills = 3;
    expect(await runtime.workspaceOutOfMemory()).toBe(true);
  });

  it('notices a kill that happened before the first look at a container', async () => {
    const { runtime } = workspaceWith({ id: 'a', running: true, kills: 2 });
    expect(await runtime.workspaceOutOfMemory()).toBe(true);
    expect(await runtime.workspaceOutOfMemory()).toBe(false);
  });

  it('starts counting again for a recreated container', async () => {
    const { runtime, state } = workspaceWith({ id: 'a', running: true, kills: 4 });
    await runtime.workspaceOutOfMemory();
    Object.assign(state, { id: 'b', kills: 0 });
    expect(await runtime.workspaceOutOfMemory()).toBe(false);
    state.kills = 1;
    expect(await runtime.workspaceOutOfMemory()).toBe(true);
  });

  it('still notices a container that stopped for lack of memory, and says nothing when the counter cannot be read', async () => {
    const stopped = workspaceWith({ id: 'a', running: false, kills: null, oomKilled: true });
    expect(await stopped.runtime.workspaceOutOfMemory()).toBe(true);
    const unreadable = workspaceWith({ id: 'a', running: true, kills: null });
    expect(await unreadable.runtime.workspaceOutOfMemory()).toBe(false);
  });
});

describe('a service that runs out of memory and stays up', () => {
  const services = { db: { image: 'postgres:17' }, cache: { image: 'postgres:17' } };

  /** A docker CLI where every service container runs and has its own kernel counter of memory kills. */
  function servicesWith(kills: Record<string, number | null>, ids: Record<string, string> = {}) {
    const out = (text: string, code = 0) => ({ code, stdout: Buffer.from(text), stderr: '', timedOut: false });
    const docker = new Docker('docker', async (_cli, args) => {
      const name = args[0] === 'exec' ? args[1]! : args.at(-1)!;
      const service = name.split('-').at(-1)!;
      if (args[0] === 'container' && args[1] === 'inspect') {
        if (!(service in kills)) return out('', 1);
        return out(
          JSON.stringify([
            {
              Id: ids[service] ?? `id-${service}`,
              Name: `/${name}`,
              State: { Running: true },
              Config: { Image: 'x', Labels: {} },
              HostConfig: { PortBindings: {} },
            },
          ]),
        );
      }
      if (args[0] === 'exec')
        return kills[service] === null || kills[service] === undefined
          ? out('', 1)
          : out(`oom_kill ${kills[service]}\n`);
      return out('');
    });
    const runtime = new DockerRuntime({ dockerHostPath: (path: string) => path } as unknown as Platform, {
      contextRoot: '/nowhere',
      qaBuildRoot: '/nowhere/qa',
    });
    (runtime as unknown as Record<string, unknown>).docker = async () => docker;
    runtime.setProject('shop');
    runtime.setResources({ services });
    return { runtime, kills, ids };
  }

  it('names the services where the kernel killed a process since the last time, once per kill', async () => {
    const { runtime, kills } = servicesWith({ db: 0, cache: 0 });
    expect(await runtime.servicesOutOfMemory()).toEqual([]);
    kills.db = 1;
    expect(await runtime.servicesOutOfMemory()).toEqual(['db']);
    expect(await runtime.servicesOutOfMemory()).toEqual([]);
    kills.db = 2;
    kills.cache = 1;
    expect(await runtime.servicesOutOfMemory()).toEqual(['db', 'cache']);
  });

  it('starts counting again for a recreated service, and skips one that is missing or unreadable', async () => {
    const { runtime, kills, ids } = servicesWith({ db: 3, cache: null });
    expect(await runtime.servicesOutOfMemory()).toEqual(['db']);
    ids.db = 'another-container';
    kills.db = 0;
    expect(await runtime.servicesOutOfMemory()).toEqual([]);
    delete kills.db;
    expect(await runtime.servicesOutOfMemory()).toEqual([]);
  });

  it('asks nothing for a project without services', async () => {
    const { runtime } = servicesWith({});
    runtime.setResources({});
    expect(await runtime.servicesOutOfMemory()).toEqual([]);
  });
});
