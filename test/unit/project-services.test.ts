import { describe, expect, it } from 'vitest';
import { SERVICE_IMAGES } from '@bug-detective/catalog/contract';
import type { ProjectServices as Declared } from '@bug-detective/catalog/contract';
import { Docker } from '../../src/main/services/docker.ts';
import type { CommandRunner } from '../../src/main/services/process.ts';
import { ProjectServices, declarationKey, serviceNames } from '../../src/main/services/project-services.ts';

const IMAGE = SERVICE_IMAGES['postgres:17']!;
const declared: Declared = {
  db: { image: 'postgres:17', env: { POSTGRES_PASSWORD: 'shop' }, variables: { DATABASE_URL: 'pg://{{host}}:{{port}}' } },
};
const CONTAINER = 'bugdetective-svc-shop-db';
const VOLUME = 'bugdetective-svcdata-shop-db-0';

interface FakeContainer {
  running: boolean;
  labels: Record<string, string>;
  oom?: boolean;
}

/**
 * A docker CLI over a small in-memory world. `ready` says whether the readiness command passes;
 * `runFails` makes `docker run` fail; `dies` makes a started container stop at once.
 */
function world(options: { ready?: () => boolean; runFails?: string; dies?: { oom?: boolean; log: string } } = {}) {
  const containers: Record<string, FakeContainer> = {};
  const volumes = new Set<string>();
  const calls: string[][] = [];
  const out = (text = '', code = 0, stderr = '') => ({ code, stdout: Buffer.from(text), stderr, timedOut: false });
  const labelsOf = (args: readonly string[]) =>
    Object.fromEntries(args.flatMap((arg, index) => (arg === '--label' ? [args[index + 1]!.split(/=(.*)/s).slice(0, 2)] : [])));
  const runner: CommandRunner = async (_cli, args) => {
    calls.push([...args]);
    const [a, b] = args;
    const last = args.at(-1)!;
    if (a === 'volume' && b === 'inspect') return out('', volumes.has(args[2]!) ? 0 : 1);
    if (a === 'volume' && b === 'create') return (volumes.add(last), out());
    if (a === 'volume' && b === 'rm') return (volumes.delete(last), out());
    if (a === 'volume' && b === 'ls') return out([...volumes].join('\n'));
    if (a === 'container' && b === 'ls') return out(Object.keys(containers).join('\n'));
    if (a === 'container' && b === 'rm') return (delete containers[last], out());
    if (a === 'container' && b === 'stop') {
      for (const name of args.slice(2).filter((arg) => arg in containers)) containers[name]!.running = false;
      return out();
    }
    if (a === 'container' && b === 'start') return ((containers[last]!.running = !options.dies), out());
    if (a === 'container' && b === 'inspect') {
      const name = last;
      const container = containers[name];
      if (!container) return out('', 1);
      if (args.includes('--format')) return out(String(container.oom ?? false));
      return out(
        JSON.stringify([
          {
            Id: `id-${name}`,
            Name: `/${name}`,
            State: { Running: container.running },
            Config: { Image: IMAGE.reference, Labels: container.labels },
            HostConfig: { PortBindings: {} },
            NetworkSettings: { Networks: { 'bugdetective-net-shop': {} } },
          },
        ]),
      );
    }
    if (a === 'run') {
      if (options.runFails) return out('', 125, options.runFails);
      const name = args[args.indexOf('--name') + 1]!;
      containers[name] = { running: !options.dies, labels: labelsOf(args), oom: options.dies?.oom };
      return out('id');
    }
    // docker exec fails on a container that is not running.
    if (a === 'exec') return out('', containers[args[1]!]?.running && (options.ready ?? (() => true))() ? 0 : 1);
    if (a === 'logs') return out('', 0, options.dies?.log ?? '');
    return out();
  };
  const of = (...start: string[]) => calls.filter((call) => start.every((word, index) => call[index] === word));
  return { docker: new Docker('docker', runner), containers, volumes, calls, of };
}

const servicesOf = (docker: Docker, services: Declared = declared, extra: { readyTimeoutMs?: number } = {}) =>
  new ProjectServices({ docker, prefix: 'bugdetective', project: 'shop', network: 'bugdetective-net-shop', services, pollMs: 1, ...extra });

describe('the names of a service', () => {
  it('names the container and one volume per data path after the project and the service', () => {
    expect(serviceNames('bugdetective', 'shop', 'db', IMAGE)).toEqual({
      container: CONTAINER,
      volumes: { '/var/lib/postgresql/data': VOLUME },
    });
  });
});

describe('ProjectServices.ensureRunning', () => {
  it('creates the labelled volume and runs the service on the internal network only, under its own name', async () => {
    const { docker, of } = world();
    const statuses = await servicesOf(docker).ensureRunning();

    expect(statuses).toEqual([{ name: 'db', image: 'postgres:17', state: 'ready' }]);
    expect(of('volume', 'create')).toEqual([
      ['volume', 'create', '--label', 'bugdetective.role=service-data', '--label', 'bugdetective.project=shop', VOLUME],
    ]);
    const [run] = of('run');
    const text = run!.join(' ');
    expect(run).toContain('--detach');
    expect(text).toContain('--pull never');
    expect(text).toContain(`--name ${CONTAINER}`);
    expect(text).toContain('--network bugdetective-net-shop --network-alias db');
    expect(text).toContain('--label bugdetective.role=service');
    expect(text).toContain('--label bugdetective.project=shop');
    expect(text).toContain(`--label bugdetective.service-key=${declarationKey(declared.db!)}`);
    expect(text).toContain(`--mount type=volume,src=${VOLUME},dst=/var/lib/postgresql/data`);
    expect(text).toContain('--cap-drop ALL');
    expect(text).toContain('--restart no');
    expect(text).not.toContain('--publish');
    expect(run!.at(-1)).toBe(IMAGE.reference);
    expect(of('exec')[0]).toEqual(['exec', CONTAINER, ...IMAGE.ready]);
  });

  it('waits until the service is ready', async () => {
    let checks = 0;
    const { docker, of } = world({ ready: () => ++checks >= 3 });
    expect((await servicesOf(docker).ensureRunning())[0]!.state).toBe('ready');
    expect(of('exec')).toHaveLength(3);
  });

  it('starts a stopped container again, keeping it and its data', async () => {
    const { docker, containers, of } = world();
    const services = servicesOf(docker);
    await services.ensureRunning();
    containers[CONTAINER]!.running = false;

    expect((await services.ensureRunning())[0]!.state).toBe('ready');
    expect(of('run')).toHaveLength(1);
    expect(of('container', 'start')).toEqual([['container', 'start', CONTAINER]]);
    expect(of('volume', 'rm')).toHaveLength(0);
  });

  it('leaves a running, ready service alone', async () => {
    const { docker, of } = world();
    const services = servicesOf(docker);
    await services.ensureRunning();
    await services.ensureRunning();
    expect(of('run')).toHaveLength(1);
    expect(of('container', 'rm')).toHaveLength(0);
  });

  it('recreates the container when the declaration changed, and keeps the volume', async () => {
    const { docker, of, volumes } = world();
    await servicesOf(docker).ensureRunning();
    const changed: Declared = { db: { ...declared.db!, env: { POSTGRES_PASSWORD: 'other' } } };

    expect((await servicesOf(docker, changed).ensureRunning())[0]!.state).toBe('ready');
    expect(of('container', 'rm').map((call) => call.at(-1))).toEqual([CONTAINER]);
    expect(of('run')).toHaveLength(2);
    expect(of('run')[1]!.join(' ')).toContain('POSTGRES_PASSWORD=other');
    expect(volumes.has(VOLUME)).toBe(true);
  });

  it('reports a service that cannot be created, without throwing', async () => {
    const { docker } = world({ runFails: 'docker: Error response from daemon: no such image' });
    expect(await servicesOf(docker).ensureRunning()).toEqual([
      { name: 'db', image: 'postgres:17', state: 'failed', reason: 'docker: Error response from daemon: no such image' },
    ]);
  });

  it('reports a service that stops at once with the last line of its log', async () => {
    const { docker } = world({ dies: { log: 'initdb: starting\nError: superuser password is not specified.\n' } });
    expect(await servicesOf(docker).ensureRunning()).toEqual([
      { name: 'db', image: 'postgres:17', state: 'failed', reason: 'Error: superuser password is not specified.' },
    ]);
  });

  it('reports a service killed for lack of memory', async () => {
    const { docker } = world({ dies: { oom: true, log: 'Killed\n' } });
    expect((await servicesOf(docker).ensureRunning())[0]).toMatchObject({ name: 'db', state: 'oom' });
  });

  it('reports a service that is not ready in time', async () => {
    const { docker } = world({ ready: () => false });
    expect(await servicesOf(docker, declared, { readyTimeoutMs: 15 }).ensureRunning()).toEqual([
      { name: 'db', image: 'postgres:17', state: 'failed', reason: 'not ready after 0.015 s' },
    ]);
  });

  it('starts the other services when one fails', async () => {
    const { docker, containers } = world();
    const two: Declared = { db: declared.db!, audit: { image: 'postgres:17' } };
    const statuses = await servicesOf(docker, two).ensureRunning();
    expect(statuses.map((status) => [status.name, status.state])).toEqual([
      ['db', 'ready'],
      ['audit', 'ready'],
    ]);
    expect(Object.keys(containers)).toEqual([CONTAINER, 'bugdetective-svc-shop-audit']);
  });

  it('does nothing for a project without services', async () => {
    const { docker, calls } = world();
    expect(await servicesOf(docker, {}).ensureRunning()).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe('ProjectServices, the rest', () => {
  it('gives the variables with the service name as the host and the image port', () => {
    const { docker } = world();
    expect(servicesOf(docker).variables()).toEqual({ DATABASE_URL: 'pg://db:5432' });
  });

  it('status creates nothing: starting without a container, ready, failed or oom with one', async () => {
    const { docker, containers, of } = world();
    const services = servicesOf(docker);
    expect(await services.status()).toEqual([{ name: 'db', image: 'postgres:17', state: 'starting' }]);
    expect(of('run')).toHaveLength(0);

    await services.ensureRunning();
    expect((await services.status())[0]!.state).toBe('ready');
    containers[CONTAINER]!.running = false;
    expect((await services.status())[0]!.state).toBe('failed');
    containers[CONTAINER]!.oom = true;
    expect((await services.status())[0]!.state).toBe('oom');
  });

  it('stop stops the containers and keeps the volumes', async () => {
    const { docker, containers, volumes, of } = world();
    const services = servicesOf(docker);
    await services.ensureRunning();
    await services.stop();
    expect(of('container', 'stop')[0]!.at(-1)).toBe(CONTAINER);
    expect(containers[CONTAINER]!.running).toBe(false);
    expect(volumes.has(VOLUME)).toBe(true);
  });

  it('removeAll removes the containers, then the volumes, from the listing by label, and checks again', async () => {
    const { docker, containers, volumes, calls, of } = world();
    const services = servicesOf(docker);
    await services.ensureRunning();
    await services.removeAll();

    expect(containers).toEqual({});
    expect(volumes.size).toBe(0);
    const listing = of('container', 'ls')[0]!.join(' ');
    expect(listing).toContain('label=bugdetective.role=service');
    expect(listing).toContain('label=bugdetective.project=shop');
    expect(of('volume', 'ls')[0]!.join(' ')).toContain('label=bugdetective.role=service-data');
    const order = calls.map((call) => call.slice(0, 2).join(' '));
    expect(order.indexOf('container rm')).toBeLessThan(order.indexOf('volume rm'));
    expect(of('container', 'ls')).toHaveLength(2);
    expect(of('volume', 'ls')).toHaveLength(2);
  });
});
