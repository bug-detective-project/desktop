import { describe, expect, it } from 'vitest';
import { Docker } from '../../src/main/services/docker.ts';
import { HARDENING_ARGS, QA_LIMITS, WORKSPACE_LIMITS, containerLimits, limitArgs } from '../../src/main/services/limits.ts';
import type { RunResult } from '../../src/main/services/process.ts';
import { QaRunner } from '../../src/main/services/qa.ts';
import { resourceNames } from '../../src/main/services/workspace.ts';

const ok = (stdout = ''): RunResult => ({ code: 0, stdout: Buffer.from(stdout), stderr: '', timedOut: false });

/** A docker CLI whose QA run dies with SIGKILL and whose inspect says the kernel killed it. */
function fakeDocker(oom: boolean) {
  const calls: string[][] = [];
  const docker = new Docker('docker', async (_command, args) => {
    calls.push([...args]);
    if (args[0] === 'run' && args.includes('--json')) {
      return { ...ok(), code: 137 };
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      return ok(oom ? 'true\n' : 'false\n');
    }
    if (args[0] === 'container' && args[1] === 'cp') {
      return { ...ok(), code: 1, stderr: 'no such file' };
    }
    return ok();
  });
  return { docker, calls };
}

function runner(docker: Docker) {
  return new QaRunner({ docker, image: 'qa:test', dockerHostPath: (path) => path, names: resourceNames('bugdetective-unit'), project: 'notes' });
}

describe('limitArgs', () => {
  it('sets the memory and pids limits and drops every capability', () => {
    expect(limitArgs(WORKSPACE_LIMITS)).toEqual(['--memory', '3g', '--pids-limit', '1024', ...HARDENING_ARGS]);
    expect(limitArgs(QA_LIMITS)).toEqual(['--memory', '2g', '--pids-limit', '512', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges']);
  });
});

describe('containerLimits', () => {
  it('takes the defaults without the environment variables', () => {
    expect(containerLimits('workspace', {})).toEqual(WORKSPACE_LIMITS);
    expect(containerLimits('qa', {})).toEqual(QA_LIMITS);
  });

  it('reads the environment variables, memory as docker takes it and pids as a number', () => {
    const env = { BUGDETECTIVE_WORKSPACE_MEMORY: '6G', BUGDETECTIVE_WORKSPACE_PIDS: '2048', BUGDETECTIVE_QA_MEMORY: '2560m', BUGDETECTIVE_QA_PIDS: '256' };
    expect(containerLimits('workspace', env)).toEqual({ memory: '6g', pids: 2048 });
    expect(containerLimits('qa', env)).toEqual({ memory: '2560m', pids: 256 });
  });

  it('keeps the default for a value docker would refuse', () => {
    const env = { BUGDETECTIVE_WORKSPACE_MEMORY: 'lots', BUGDETECTIVE_WORKSPACE_PIDS: '0', BUGDETECTIVE_QA_MEMORY: '', BUGDETECTIVE_QA_PIDS: '12 pids' };
    expect(containerLimits('workspace', env)).toEqual(WORKSPACE_LIMITS);
    expect(containerLimits('qa', env)).toEqual(QA_LIMITS);
  });

  it('is read when a container is created: the QA runner picks a change up', async () => {
    const before = process.env.BUGDETECTIVE_QA_MEMORY;
    process.env.BUGDETECTIVE_QA_MEMORY = '1536m';
    try {
      const { docker, calls } = fakeDocker(false);
      await runner(docker).prepareDependencies(1);
      const run = calls.find((args) => args[0] === 'run')!;
      expect(run[run.indexOf('--memory') + 1]).toBe('1536m');
    } finally {
      if (before === undefined) delete process.env.BUGDETECTIVE_QA_MEMORY;
      else process.env.BUGDETECTIVE_QA_MEMORY = before;
    }
  });
});

describe('QaRunner', () => {
  it('mounts the dependency cache read-only for a test run and writable only for the preparation', () => {
    const { docker } = fakeDocker(false);
    const qa = runner(docker);
    const cache = (args: string[]) => args[args.findIndex((arg) => arg.includes('dst=/cache'))];
    expect(cache(qa.containerArgs('x', { network: false, packageDir: '/tmp/pkg' }))).toMatch(/dst=\/cache,readonly/);
    expect(cache(qa.containerArgs('x', { network: true }))).not.toMatch(/readonly/);
  });

  it('records an out-of-memory result when the QA container was OOM-killed, and removes the container', async () => {
    const { docker, calls } = fakeDocker(true);
    const result = await runner(docker).run({ ticket: 1, language: 'en', timeoutSeconds: 180, packageDir: '/tmp/pkg' });
    expect(result).toMatchObject({ ticket: 1, status: 'outOfMemory', tests: [] });
    const qaRun = calls.find((args) => args[0] === 'run' && args.includes('--json'))!;
    const name = qaRun[qaRun.indexOf('--name') + 1];
    expect(calls).toContainEqual(['container', 'inspect', '--format', '{{.State.OOMKilled}}', name]);
    expect(calls).toContainEqual(['container', 'rm', '--force', '--volumes=false', name]);
  });

  it('starts no container once the shutdown aborted the run', async () => {
    const { docker, calls } = fakeDocker(false);
    const controller = new AbortController();
    controller.abort();
    await expect(runner(docker).run({ ticket: 1, language: 'en', timeoutSeconds: 180, packageDir: '/tmp/pkg', signal: controller.signal })).rejects.toThrow();
    expect(calls.filter((args) => args[0] === 'run')).toEqual([]);
  });

  it('treats exit code 137 without an OOM kill as a missing result', async () => {
    const { docker } = fakeDocker(false);
    await expect(runner(docker).run({ ticket: 1, language: 'en', timeoutSeconds: 180, packageDir: '/tmp/pkg' })).rejects.toThrow(/did not produce a result/);
  });

  it('runs QA, the dependency preparation and the helpers with the QA limits, as node', async () => {
    const { docker, calls } = fakeDocker(false);
    await runner(docker).prepareDependencies(1);
    await runner(docker).run({ ticket: 1, language: 'en', timeoutSeconds: 180, packageDir: '/tmp/pkg' }).catch(() => {});
    const runs = calls.filter((args) => args[0] === 'run');
    expect(runs.length).toBeGreaterThanOrEqual(3);
    for (const args of runs) {
      expect(args).toEqual(expect.arrayContaining(limitArgs(QA_LIMITS)));
      expect(args).not.toContain('root');
    }
    const copy = runs.find((args) => args.includes('--entrypoint'))!;
    expect(copy).toContain('PROJECT_ID=notes');
    const deps = runs.find((args) => args.includes('--deps-only'))!;
    expect(deps[deps.indexOf('--workspace') + 1]).toBe('/workspace/notes');
  });
});

describe('a QA run of a project with services', () => {
  const services = { db: { image: 'postgres:17', env: { POSTGRES_PASSWORD: 'notes' }, variables: { DATABASE_URL: 'pg://{{host}}:{{port}}' } } };
  const RESULT = JSON.stringify({ ticket: 1, gate: 2, status: 'passed', message: 'ok', tests: [], durationMs: 5 });

  /** A docker CLI where containers and networks exist once created; the QA run answers with a result file. */
  async function world(options: { serviceDies?: boolean } = {}) {
    const { textFile, writeTar } = await import('@bug-detective/catalog/contract');
    const resultTar = await writeTar([textFile('qa-result.json', RESULT)]);
    const containers = new Map<string, boolean>();
    const networks = new Set<string>();
    const calls: string[][] = [];
    const docker = new Docker('docker', async (_command, args) => {
      calls.push([...args]);
      const [a, b] = args;
      const last = args.at(-1)!;
      if (a === 'network' && b === 'inspect') return { ...ok(), code: networks.has(last) ? 0 : 1 };
      if (a === 'network' && b === 'create') return (networks.add(last), ok());
      if (a === 'network' && b === 'rm') return (networks.delete(last), ok());
      if (a === 'container' && b === 'rm') return (containers.delete(last), ok());
      if (a === 'container' && b === 'inspect') {
        if (!containers.has(last)) return { ...ok(), code: 1 };
        if (args.includes('--format')) return ok('false\n');
        return ok(JSON.stringify([{ Id: 'id', Name: `/${last}`, State: { Running: containers.get(last) }, Config: { Image: 'x', Labels: {} }, HostConfig: { PortBindings: {} } }]));
      }
      if (a === 'run') {
        const name = args[args.indexOf('--name') + 1]!;
        const service = args.includes('--detach');
        containers.set(name, service ? !options.serviceDies : false);
        return ok();
      }
      if (a === 'exec') return { ...ok(), code: containers.get(args[1]!) ? 0 : 1 };
      if (a === 'logs') return { ...ok(), stderr: 'Error: superuser password is not specified.\n' };
      if (a === 'container' && b === 'cp') return { code: 0, stdout: resultTar, stderr: '', timedOut: false };
      return ok();
    });
    const qaRun = () => calls.find((call) => call[0] === 'run' && call.includes('--json'));
    return { docker, calls, containers, networks, qaRun };
  }

  const request = { ticket: 1, language: 'en' as const, timeoutSeconds: 60, packageDir: '/pkg' };
  const withServices = (docker: Docker) =>
    new QaRunner({ docker, image: 'qa:test', dockerHostPath: (path) => path, names: resourceNames('bugdetective-unit'), project: 'notes', services, servicePollMs: 1 });

  it('puts the QA container on the network of its own services, with their variables, and removes everything after the run', async () => {
    const { docker, containers, networks, qaRun, calls } = await world();
    const result = await withServices(docker).run(request);
    expect(result.status).toBe('passed');

    const run = qaRun()!;
    const network = run[run.indexOf('--network') + 1]!;
    expect(network).toMatch(/^bugdetective-unit-qanet-notes-[0-9a-f]{8}$/);
    expect(run).not.toContain('none');
    expect(run[run.indexOf('--env') + 1]).toBe('DATABASE_URL=pg://db:5432');
    const service = calls.find((call) => call[0] === 'run' && call.includes('--detach'))!;
    expect(service.join(' ')).toContain(`--network ${network} --network-alias db`);
    // The service is ready before the QA container exists.
    expect(calls.indexOf(service)).toBeLessThan(calls.indexOf(run));
    expect([...containers.keys()]).toEqual([]);
    expect([...networks]).toEqual([]);
  });

  it('keeps a project without services on no network at all', async () => {
    const { docker, qaRun, networks, calls } = await world();
    await runner(docker).run(request);
    const run = qaRun()!;
    expect(run[run.indexOf('--network') + 1]).toBe('none');
    expect(run).not.toContain('--env');
    expect(networks.size).toBe(0);
    expect(calls.some((call) => call[0] === 'network' && call[1] === 'create')).toBe(false);
  });

  it('does not run QA when a service does not start, says which one and why, and leaves nothing', async () => {
    const { docker, containers, networks, qaRun } = await world({ serviceDies: true });
    await expect(withServices(docker).run(request)).rejects.toThrow(/The service db \(postgres:17\) for QA did not start: it stopped: Error: superuser password is not specified\./);
    expect(qaRun()).toBeUndefined();
    expect([...containers.keys()]).toEqual([]);
    expect([...networks]).toEqual([]);
  });

  it('the leftover cleanup also sweeps QA services and networks', async () => {
    const { docker, calls } = await world();
    await withServices(docker).cleanupLeftovers();
    expect(calls.some((call) => call.join(' ').includes('label=bugdetective.role=qa-service'))).toBe(true);
    expect(calls.some((call) => call.join(' ').includes('label=bugdetective.role=qa-network'))).toBe(true);
  });
});
