import { describe, expect, it } from 'vitest';
import { Docker } from '../../src/main/services/docker.ts';
import type { CommandRunner } from '../../src/main/services/process.ts';
import { Workspace } from '../../src/main/services/workspace.ts';

const IMAGE = 'bugdetective-workspace:test';
const NETWORK = 'bugdetective-net-shop';

/** A docker CLI over an in-memory set of containers; every other command succeeds. */
function world() {
  const containers: Record<string, { running: boolean; labels: Record<string, string>; networks: string[]; ports: Record<string, { HostPort: string }[]> }> = {};
  const calls: string[][] = [];
  const out = (text = '', code = 0) => ({ code, stdout: Buffer.from(text), stderr: '', timedOut: false });
  const labelsOf = (args: readonly string[]) =>
    Object.fromEntries(args.flatMap((arg, index) => (arg === '--label' ? [args[index + 1]!.split(/=(.*)/s).slice(0, 2)] : [])));
  const runner: CommandRunner = async (_cli, args) => {
    calls.push([...args]);
    const [a, b] = args;
    const last = args.at(-1)!;
    const created = a === 'run' || (a === 'container' && b === 'create');
    if (created) {
      const name = args[args.indexOf('--name') + 1]!;
      const ports = Object.fromEntries(
        args.flatMap((arg, index) => {
          if (arg !== '--publish') return [];
          const [, host, container] = args[index + 1]!.split(':');
          return [[`${container}/tcp`, [{ HostPort: host! }]]];
        }),
      );
      containers[name] = { running: a === 'run', labels: labelsOf(args), networks: [args[args.indexOf('--network') + 1]!], ports };
      return out('id');
    }
    if (a === 'network' && b === 'connect') return (containers[last]!.networks.push(args[2]!), out());
    if (a === 'container' && b === 'start') return ((containers[last]!.running = true), out());
    if (a === 'container' && b === 'rm') return (delete containers[last], out());
    if (a === 'container' && b === 'inspect') {
      const container = containers[last];
      if (!container) return out('', 1);
      return out(
        JSON.stringify([
          {
            Id: `id-${last}`,
            Name: `/${last}`,
            State: { Running: container.running },
            Config: { Image: IMAGE, Labels: container.labels },
            HostConfig: { PortBindings: container.ports },
            NetworkSettings: { Networks: Object.fromEntries(container.networks.map((network) => [network, {}])) },
          },
        ]),
      );
    }
    return out();
  };
  const runs = () => calls.filter((call) => call[0] === 'run');
  return { docker: new Docker('docker', runner), containers, calls, runs };
}

const workspaceOf = (
  docker: Docker,
  extra: {
    variables?: Record<string, string>;
    memory?: string;
    publishedServices?: { name: string; port: number }[];
    isPortFree?: (port: number) => Promise<boolean>;
    anyFreePort?: () => Promise<number>;
  } = {},
) => new Workspace({ docker, image: IMAGE, isPortFree: async () => true, project: 'shop', ...extra });

/** True when `flag value` appears as two consecutive arguments. */
const has = (args: string[], flag: string, value: string) => args.some((arg, index) => arg === flag && args[index + 1] === value);

describe("the workspace and the project's services", () => {
  it('starts with the variables of the services and the memory the project asks for', async () => {
    const { docker, runs } = world();
    await workspaceOf(docker, { variables: { DATABASE_URL: 'pg://db:5432', CACHE_URL: 'redis://cache:6379' }, memory: '4g' }).ensureRunning();
    const [run] = runs();
    expect(has(run!, '--env', 'DATABASE_URL=pg://db:5432')).toBe(true);
    expect(has(run!, '--env', 'CACHE_URL=redis://cache:6379')).toBe(true);
    expect(has(run!, '--memory', '4g')).toBe(true);
    expect(has(run!, '--network', NETWORK)).toBe(true);
    expect(run!.at(-1)).toBe(IMAGE);
  });

  it('is created exactly as before for a project without services', async () => {
    const { docker, runs } = world();
    await workspaceOf(docker).ensureRunning();
    const [run] = runs();
    expect(run).not.toContain('--env');
    expect(run!.join(' ')).not.toContain('bugdetective.env-key');
    expect(has(run!, '--memory', '3g')).toBe(true);
  });

  it('lets the developer override win over the memory the project asks for', async () => {
    const { docker, runs } = world();
    process.env.BUGDETECTIVE_WORKSPACE_MEMORY = '2g';
    try {
      await workspaceOf(docker, { memory: '4g' }).ensureRunning();
    } finally {
      delete process.env.BUGDETECTIVE_WORKSPACE_MEMORY;
    }
    expect(has(runs()[0]!, '--memory', '2g')).toBe(true);
  });

  it('keeps the container while the variables and the memory are the same', async () => {
    const { docker, runs } = world();
    const options = { variables: { DATABASE_URL: 'pg://db:5432' } };
    await workspaceOf(docker, options).ensureRunning();
    await workspaceOf(docker, options).ensureRunning();
    expect(runs()).toHaveLength(1);
  });

  it.each([
    ['a variable changed', { variables: { DATABASE_URL: 'pg://db:5432/other' } }],
    ['the memory changed', { variables: { DATABASE_URL: 'pg://db:5432' }, memory: '4g' }],
    ['the project no longer declares services', {}],
  ])('recreates the container when %s, keeping the volumes', async (_, changed) => {
    const { docker, runs, calls } = world();
    await workspaceOf(docker, { variables: { DATABASE_URL: 'pg://db:5432' } }).ensureRunning();
    await workspaceOf(docker, changed).ensureRunning();
    expect(runs()).toHaveLength(2);
    expect(calls.filter((call) => call[0] === 'container' && call[1] === 'rm').map((call) => call.at(-1))).toEqual(['bugdetective-workspace']);
    expect(calls.filter((call) => call[0] === 'volume' && call[1] === 'rm')).toHaveLength(0);
  });
});

describe('the published port of a service', () => {
  const FORWARDER = 'bugdetective-forward-shop';
  const forwarders = (calls: string[][]) => calls.filter((call) => call[0] === 'container' && call[1] === 'create');
  const db = [{ name: 'db', port: 5432 }];

  it('goes through the forwarder: published on 127.0.0.1 only, on the service port when it is free', async () => {
    const { docker, calls } = world();
    const workspace = workspaceOf(docker, { publishedServices: db });
    await workspace.ensureRunning();
    const [create] = forwarders(calls);
    expect(create![create!.indexOf('--name') + 1]).toBe(FORWARDER);
    expect(create!.find((arg) => arg.startsWith('BUGDETECTIVE_FORWARD='))).toMatch(/,20000:db:5432$/);
    expect(has(create!, '--publish', '127.0.0.1:5432:20000')).toBe(true);
    expect(await workspace.servicePorts()).toEqual({ db: 5432 });
  });

  it('takes the next free port when the service port is taken on the computer', async () => {
    const { docker } = world();
    const workspace = workspaceOf(docker, { publishedServices: db, isPortFree: async (port) => port !== 5432 });
    await workspace.ensureRunning();
    expect(await workspace.servicePorts()).toEqual({ db: 5433 });
  });

  it('asks the system for a port when every port near the preferred one is reserved', async () => {
    // Windows can reserve whole blocks (2741 to 3240): no port from 3001 to 3200 can be listened on.
    const { docker, calls } = world();
    const handedOut = [55001, 55002];
    const workspace = workspaceOf(docker, { isPortFree: async (port) => port < 2741 || port > 3240, anyFreePort: async () => handedOut.shift()! });
    await workspace.ensureRunning();
    const [create] = forwarders(calls);
    expect(has(create!, '--publish', '127.0.0.1:5173:15173')).toBe(true);
    expect(create!.some((arg) => /^127\.0\.0\.1:55001:/.test(arg))).toBe(true);
  });

  it('gives two services of the same image different ports', async () => {
    const { docker } = world();
    const workspace = workspaceOf(docker, { publishedServices: [...db, { name: 'audit', port: 5432 }] });
    await workspace.ensureRunning();
    expect(await workspace.servicePorts()).toEqual({ db: 5432, audit: 5433 });
  });

  it('publishes nothing of a service when the project asks for none', async () => {
    const { docker, calls } = world();
    const workspace = workspaceOf(docker);
    await workspace.ensureRunning();
    const [create] = forwarders(calls);
    expect(create!.join(' ')).not.toContain('20000');
    expect(create!.join(' ')).not.toContain('bugdetective.forward-key');
    expect(await workspace.servicePorts()).toEqual({});
  });

  it('recreates the forwarder when the published services change', async () => {
    const { docker, calls } = world();
    await workspaceOf(docker).ensureRunning();
    await workspaceOf(docker, { publishedServices: db }).ensureRunning();
    expect(forwarders(calls)).toHaveLength(2);
    await workspaceOf(docker, { publishedServices: db }).ensureRunning();
    expect(forwarders(calls)).toHaveLength(2);
  });
});
