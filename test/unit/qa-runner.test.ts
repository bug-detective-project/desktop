import { describe, expect, it } from 'vitest';
import { Docker } from '../../src/main/services/docker.ts';
import { HARDENING_ARGS, QA_LIMITS, WORKSPACE_LIMITS, limitArgs } from '../../src/main/services/limits.ts';
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

describe('QaRunner', () => {
  it('records an out-of-memory result when the QA container was OOM-killed, and removes the container', async () => {
    const { docker, calls } = fakeDocker(true);
    const result = await runner(docker).run({ ticket: 1, language: 'en', timeoutSeconds: 180, packageDir: '/tmp/pkg' });
    expect(result).toMatchObject({ ticket: 1, status: 'outOfMemory', tests: [] });
    const qaRun = calls.find((args) => args[0] === 'run' && args.includes('--json'))!;
    const name = qaRun[qaRun.indexOf('--name') + 1];
    expect(calls).toContainEqual(['container', 'inspect', '--format', '{{.State.OOMKilled}}', name]);
    expect(calls).toContainEqual(['container', 'rm', '--force', '--volumes=false', name]);
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
