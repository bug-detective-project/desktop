import { describe, expect, it } from 'vitest';
import { SERVICE_IMAGES } from '@bug-detective/catalog/contract';
import type { ProjectServices as Declared } from '@bug-detective/catalog/contract';
import { Docker } from '../../src/main/services/docker.ts';
import type { CommandRunner } from '../../src/main/services/process.ts';
import { QaServiceError, QaServices, qaServiceNames, sweepQaServices } from '../../src/main/services/qa-services.ts';

const IMAGE = SERVICE_IMAGES['postgres:17']!;
const declared: Declared = { db: { image: 'postgres:17', env: { POSTGRES_PASSWORD: 'shop' }, variables: { DATABASE_URL: 'pg://{{host}}:{{port}}' } } };
const NETWORK = 'bugdetective-qanet-shop-run1';
const CONTAINER = 'bugdetective-qasvc-shop-db-run1';

/** A docker CLI over in-memory containers and networks. `dies` makes a started container stop at once; `ready` answers the readiness command. */
function world(options: { ready?: () => boolean; dies?: { oom?: boolean; log: string }; runFails?: string } = {}) {
  const containers: Record<string, { running: boolean; oom?: boolean }> = {};
  const networks = new Set<string>();
  const calls: string[][] = [];
  const out = (text = '', code = 0, stderr = '') => ({ code, stdout: Buffer.from(text), stderr, timedOut: false });
  const runner: CommandRunner = async (_cli, args) => {
    calls.push([...args]);
    const [a, b] = args;
    const last = args.at(-1)!;
    if (a === 'network' && b === 'inspect') return out('', networks.has(last) ? 0 : 1);
    if (a === 'network' && b === 'create') return (networks.add(last), out());
    if (a === 'network' && b === 'rm') return (networks.delete(last), out());
    if (a === 'network' && b === 'ls') return out([...networks].join('\n'));
    if (a === 'container' && b === 'ls') return out(Object.keys(containers).join('\n'));
    if (a === 'container' && b === 'rm') return (delete containers[last], out());
    if (a === 'container' && b === 'inspect') {
      const container = containers[last];
      if (!container) return out('', 1);
      if (args.includes('--format')) return out(String(container.oom ?? false));
      return out(JSON.stringify([{ Id: 'id', Name: `/${last}`, State: { Running: container.running }, Config: { Image: IMAGE.reference, Labels: {} }, HostConfig: { PortBindings: {} }, NetworkSettings: { Networks: {} } }]));
    }
    if (a === 'run') {
      if (options.runFails) return out('', 125, options.runFails);
      containers[args[args.indexOf('--name') + 1]!] = { running: !options.dies, oom: options.dies?.oom };
      return out('id');
    }
    if (a === 'exec') return out('', containers[args[1]!]?.running && (options.ready ?? (() => true))() ? 0 : 1);
    if (a === 'logs') return out('', 0, options.dies?.log ?? '');
    return out();
  };
  const of = (...start: string[]) => calls.filter((call) => start.every((word, index) => call[index] === word));
  return { docker: new Docker('docker', runner), containers, networks, calls, of };
}

const servicesOf = (docker: Docker, extra: { readyTimeoutMs?: number } = {}) =>
  new QaServices({ docker, prefix: 'bugdetective', project: 'shop', services: declared, pollMs: 1, ...extra });

describe('the services of a QA run', () => {
  it('names the network and the containers after the project, the service and the run', () => {
    expect(qaServiceNames('bugdetective', 'shop', 'run1', declared)).toEqual({ network: NETWORK, containers: { db: CONTAINER } });
  });

  it('creates an internal network of the run and starts each service on it, with its data in memory', async () => {
    const { docker, of } = world();
    const started = await servicesOf(docker).start('run1');

    expect(started).toEqual({ network: NETWORK, variables: { DATABASE_URL: 'pg://db:5432' } });
    expect(of('network', 'create')).toEqual([['network', 'create', '--internal', '--label', 'bugdetective.role=qa-network', '--label', 'bugdetective.project=shop', NETWORK]]);
    const text = of('run')[0]!.join(' ');
    expect(text).toContain(`--name ${CONTAINER}`);
    expect(text).toContain('--pull never');
    expect(text).toContain('--label bugdetective.role=qa-service');
    expect(text).toContain('--label bugdetective.project=shop');
    expect(text).toContain(`--network ${NETWORK} --network-alias db`);
    expect(text).toContain('--tmpfs /var/lib/postgresql/data:uid=999,gid=999,mode=0700');
    expect(text).toContain('--cap-drop ALL');
    expect(text).not.toMatch(/--publish|--mount/);
    expect(of('run')[0]!.at(-1)).toBe(IMAGE.reference);
  });

  it('waits until the service is ready', async () => {
    let checks = 0;
    const { docker, of } = world({ ready: () => ++checks >= 3 });
    await servicesOf(docker).start('run1');
    expect(of('exec')).toHaveLength(3);
  });

  it.each([
    ['cannot be created', { runFails: 'Error response from daemon: No such image' }, /The service db \(postgres:17\) for QA could not be started: Error response from daemon: No such image/],
    ['stops at once', { dies: { log: 'Error: superuser password is not specified.\n' } }, /for QA did not start: it stopped: Error: superuser password is not specified\./],
    ['runs out of memory', { dies: { oom: true, log: 'Killed\n' } }, /for QA did not start: it ran out of memory/],
  ])('fails naming a service that %s, and removes everything of the run', async (_, options, message) => {
    const { docker, containers, networks } = world(options);
    const failure = await servicesOf(docker)
      .start('run1')
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(QaServiceError);
    expect((failure as Error).message).toMatch(message);
    expect(containers).toEqual({});
    expect(networks.size).toBe(0);
  });

  it('fails when a service is not ready in time, and removes everything of the run', async () => {
    const { docker, containers, networks } = world({ ready: () => false });
    await expect(servicesOf(docker, { readyTimeoutMs: 15 }).start('run1')).rejects.toThrow(/did not start: it was not ready after 0\.015 s/);
    expect(containers).toEqual({});
    expect(networks.size).toBe(0);
  });

  it('remove takes the containers first, then the network', async () => {
    const { docker, containers, networks, calls } = world();
    const services = servicesOf(docker);
    await services.start('run1');
    await services.remove('run1');
    expect(containers).toEqual({});
    expect(networks.size).toBe(0);
    const order = calls.map((call) => call.slice(0, 2).join(' '));
    expect(order.lastIndexOf('container rm')).toBeLessThan(order.lastIndexOf('network rm'));
  });

  it('the sweep removes the services and networks a crash left, of any run, and only those of the app', async () => {
    const { docker, containers, networks, of } = world();
    await servicesOf(docker).start('run1');
    await servicesOf(docker).start('run2');
    containers['someone-else'] = { running: true };
    networks.add('someone-elses-network');

    const removed = await sweepQaServices(docker, 'bugdetective');
    expect(removed.sort()).toEqual([CONTAINER, 'bugdetective-qasvc-shop-db-run2', NETWORK, 'bugdetective-qanet-shop-run2'].sort());
    expect(Object.keys(containers)).toEqual(['someone-else']);
    expect([...networks]).toEqual(['someone-elses-network']);
    expect(of('container', 'ls')[0]!.join(' ')).toContain('label=bugdetective.role=qa-service');
    expect(of('network', 'ls')[0]!.join(' ')).toContain('label=bugdetective.role=qa-network');
  });
});
