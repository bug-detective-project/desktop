import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Platform, WslStatus } from '../../src/main/platform/types.ts';
import { Docker, parseDockerSize } from '../../src/main/services/docker.ts';
import { Prerequisites } from '../../src/main/services/prerequisites.ts';
import type { RunResult } from '../../src/main/services/process.ts';

const ok = (stdout: string, code = 0): RunResult => ({ code, stdout: Buffer.from(stdout), stderr: '', timedOut: false });

type Answer = (command: string, args: readonly string[]) => RunResult;

function fakePlatform(answer: Answer, wsl: WslStatus = { installed: true, version2: true, detail: 'Ubuntu (WSL 2)', version: '2.3.24.0' }): Platform {
  return {
    id: 'windows',
    runner: async (command, args) => answer(command, args),
    locateDocker: async () => ({ cli: 'docker', desktopApp: 'Docker Desktop.exe' }),
    isDockerDesktopRunning: async () => true,
    startDockerDesktop: async () => {},
    checkWsl: async () => wsl,
    locateVSCode: async () => ({ source: 'user', launcher: 'code.cmd', command: 'Code.exe', baseArgs: ['cli.js'], env: {} }),
    dockerHostPath: (path) => path,
    isPortFree: async () => true,
    browserCommand: () => null,
  };
}

const healthy: Answer = (command, args) => {
  if (command === 'docker') {
    return args.includes('{{.Server.Version}}|{{.Server.Platform.Name}}') ? ok('27.3.1|Docker Desktop 4.37.1 (178610)\n') : ok('27.3.1\n');
  }
  if (args.includes('--version')) {
    return ok('1.95.1\nf1a4fb101478ce6ec82fe9627c43efbf9e98c813\nx64\n');
  }
  if (args.includes('--list-extensions')) {
    return ok('esbenp.prettier-vscode@11.0.0\nMS-VSCODE-REMOTE.remote-containers@0.388.0\n');
  }
  return ok('', 1);
};

describe('prerequisite check', () => {
  it('reports the version of each tool', async () => {
    const report = await new Prerequisites(fakePlatform(healthy)).check();
    expect(report.allOk).toBe(true);
    expect(Object.fromEntries(report.checks.map((check) => [check.id, check.version]))).toEqual({
      docker: '4.37.1',
      wsl: '2.3.24.0',
      vscode: '1.95.1',
      devcontainers: '0.388.0',
    });
  });

  it('shows the engine version without Docker Desktop, and never fails a check because a version is unreadable', async () => {
    const engineOnly: Answer = (command, args) =>
      command === 'docker' && args.includes('{{.Server.Version}}|{{.Server.Platform.Name}}') ? ok('27.3.1|Docker Engine - Community\n') : healthy(command, args);
    expect((await new Prerequisites(fakePlatform(engineOnly)).check()).checks[0]).toEqual({ id: 'docker', status: 'ok', version: '27.3.1' });

    const noVersions: Answer = (command, args) => (args.includes('--version') && command !== 'docker' ? ok('', 1) : healthy(command, args));
    const report = await new Prerequisites(fakePlatform(noVersions, { installed: true, version2: true, detail: '' })).check();
    expect(report.allOk).toBe(true);
    expect(report.checks.find((check) => check.id === 'vscode')?.version).toBeUndefined();
    expect(report.checks.find((check) => check.id === 'wsl')?.version).toBeUndefined();
  });

  it('tells a missing extension from a failed extension list', async () => {
    const missing: Answer = (command, args) => (args.includes('--list-extensions') ? ok('esbenp.prettier-vscode@11.0.0\n') : healthy(command, args));
    expect((await new Prerequisites(fakePlatform(missing)).check()).checks[3]).toMatchObject({ status: 'missing', reason: 'extensionMissing' });
    const failing: Answer = (command, args) => (args.includes('--list-extensions') ? ok('', 1) : healthy(command, args));
    expect((await new Prerequisites(fakePlatform(failing)).check()).checks[3]).toMatchObject({ status: 'missing', reason: 'checkFailed' });
  });

  it('marks WSL as not needed on plain Linux', async () => {
    const report = await new Prerequisites(fakePlatform(healthy, { installed: true, version2: true, detail: 'Not needed on Linux', notNeeded: true })).check();
    expect(report.checks[1]).toMatchObject({ id: 'wsl', status: 'ok', reason: 'notNeeded' });
  });
});

describe('docker disk usage', () => {
  it('parses the sizes docker prints', () => {
    expect(parseDockerSize('80.31MB')).toBe(80_310_000);
    expect(parseDockerSize('1.2GB')).toBe(1_200_000_000);
    expect(parseDockerSize('512kB')).toBe(512_000);
    expect(parseDockerSize('0B')).toBe(0);
    expect(parseDockerSize('N/A')).toBeNull();
  });

  it('reads image sizes and the sizes of our own volumes only', async () => {
    const docker = new Docker('docker', async (_command, args) => {
      if (args[0] === 'image') {
        return args.at(-1) === 'bugdetective-qa:1' ? ok('3010000000\n') : ok('', 1);
      }
      return ok(
        `${JSON.stringify([
          { Name: 'bugdetective-workspace', Size: '1.12GB' },
          { Name: 'someone-else', Size: '9GB' },
          { Name: 'bugdetective-qa-cache', Size: 'N/A' },
        ])}\n`,
      );
    });
    expect(await docker.imageSize('bugdetective-qa:1')).toBe(3_010_000_000);
    expect(await docker.imageSize('missing:1')).toBeNull();
    expect(await docker.volumeSizes(['bugdetective-workspace', 'bugdetective-qa-cache'])).toEqual({ 'bugdetective-workspace': 1_120_000_000 });
  });
});

describe('Docker state and the other checks when something is missing', () => {
  const stopped: Answer = (command, args) => (command === 'docker' ? ok('', 1) : healthy(command, args));
  const platform = (answer: Answer, overrides: Partial<Platform> = {}): Platform => ({ ...fakePlatform(answer), ...overrides });

  it('tells Docker not installed, stopped, starting and running apart', async () => {
    const state = (answer: Answer, overrides: Partial<Platform>) => {
      const prerequisites = new Prerequisites(platform(answer, overrides));
      return prerequisites.locate().then((environment) => prerequisites.dockerState(environment));
    };
    expect(await state(healthy, { locateDocker: async () => ({ cli: null, desktopApp: null }) })).toBe('notInstalled');
    expect(await state(healthy, { locateDocker: async () => ({ cli: null, desktopApp: 'Docker Desktop.exe' }) })).toBe('notRunning');
    expect(await state(stopped, { isDockerDesktopRunning: async () => true })).toBe('starting');
    expect(await state(stopped, { isDockerDesktopRunning: async () => false })).toBe('notRunning');
    // Docker Engine on Linux: the CLI is there, the daemon does not answer.
    expect(await state(stopped, { locateDocker: async () => ({ cli: 'docker', desktopApp: null }) })).toBe('notRunning');
    expect(await state(healthy, {})).toBe('running');
  });

  it('reports a starting Docker as pending and a stopped one as missing, with the reason', async () => {
    const starting = await new Prerequisites(platform(stopped, { isDockerDesktopRunning: async () => true })).check();
    expect(starting.checks[0]).toEqual({ id: 'docker', status: 'pending', reason: 'starting' });
    const notRunning = await new Prerequisites(platform(stopped, { isDockerDesktopRunning: async () => false })).check();
    expect(notRunning.checks[0]).toEqual({ id: 'docker', status: 'missing', reason: 'notRunning' });
    expect(notRunning.allOk).toBe(false);
  });

  it('reports WSL missing, WSL 1 only, and VS Code without its CLI', async () => {
    const noWsl = await new Prerequisites(fakePlatform(healthy, { installed: false, version2: false, detail: 'wsl.exe not found' })).check();
    expect(noWsl.checks[1]).toMatchObject({ id: 'wsl', status: 'missing', reason: 'notFound', detail: 'wsl.exe not found' });
    const wsl1 = await new Prerequisites(fakePlatform(healthy, { installed: true, version2: false, detail: 'Ubuntu (WSL 1)' })).check();
    expect(wsl1.checks[1]).toMatchObject({ id: 'wsl', status: 'missing', reason: 'wsl1Only' });
    const noCode = await new Prerequisites(platform(healthy, { locateVSCode: async () => null })).check();
    expect(noCode.checks.slice(2)).toEqual([
      { id: 'vscode', status: 'missing', reason: 'cliNotFound' },
      { id: 'devcontainers', status: 'missing', reason: 'extensionMissing' },
    ]);
  });
});

describe('starting Docker Desktop', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cannot start what is not installed, and does nothing when the engine already runs', async () => {
    const notInstalled = new Prerequisites({ ...fakePlatform(healthy), locateDocker: async () => ({ cli: null, desktopApp: null }) });
    expect(await notInstalled.startDocker(await notInstalled.locate())).toBe('notInstalled');
    const start = vi.fn(async () => {});
    const running = new Prerequisites({ ...fakePlatform(healthy), startDockerDesktop: start });
    expect(await running.startDocker(await running.locate())).toBe('running');
    expect(start).not.toHaveBeenCalled();
  });

  it('starts Docker Desktop and polls until the engine answers, reporting each state', async () => {
    vi.useFakeTimers();
    let up = false;
    const answer: Answer = (command, args) => (command === 'docker' && !up ? ok('', 1) : healthy(command, args));
    const start = vi.fn(async () => {});
    const prerequisites = new Prerequisites({ ...fakePlatform(answer), startDockerDesktop: start });
    const polls: string[] = [];
    const result = prerequisites.startDocker(await prerequisites.locate(), 60_000, (state) => {
      polls.push(state);
      if (polls.length === 2) up = true;
    });
    await vi.advanceTimersByTimeAsync(3000 * 3);
    expect(await result).toBe('running');
    expect(start).toHaveBeenCalledWith('Docker Desktop.exe');
    expect(polls).toEqual(['starting', 'starting', 'running']);
  });

  it('gives up after the timeout with the last state', async () => {
    vi.useFakeTimers();
    const prerequisites = new Prerequisites({ ...fakePlatform((command, args) => (command === 'docker' ? ok('', 1) : healthy(command, args))), isDockerDesktopRunning: async () => false });
    const result = prerequisites.startDocker(await prerequisites.locate(), 10_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(await result).toBe('notRunning');
  });
});
