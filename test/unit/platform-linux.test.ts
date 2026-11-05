import { describe, expect, it } from 'vitest';
import { createLinuxPlatform, isWsl } from '../../src/main/platform/linux.ts';
import type { RunResult } from '../../src/main/services/process.ts';

const ok = (stdout: string, code = 0): RunResult => ({ code, stdout: Buffer.from(stdout), stderr: '', timedOut: false });

const CODE_CMD = '@echo off\r\n"%~dp0..\\Code.exe" "%~dp0..\\e646868227\\resources\\app\\out\\cli.js" %*\r\n';
const VSCODE = '/mnt/c/Users/João Silva/AppData/Local/Programs/Microsoft VS Code';

function fakeFs(files: Record<string, string>) {
  return {
    fileExists: (file: string) => file in files,
    readText: (file: string) => {
      if (!(file in files)) throw new Error('ENOENT');
      return files[file];
    },
  };
}

/** Answers the one cmd.exe call that reads the Windows folders. */
const windowsRunner = async (command: string, args: readonly string[]) => {
  if (command.endsWith('cmd.exe')) {
    return ok('C:\\Users\\João Silva\\AppData\\Local|C:\\Program Files|C:\\WINDOWS\r\n');
  }
  if (command.endsWith('wsl.exe') && args[0] === '--version') {
    return ok(Buffer.from('WSL version: 2.3.24.0\r\n', 'utf16le').toString('latin1'));
  }
  if (command.endsWith('tasklist.exe')) {
    return ok(args.includes('IMAGENAME eq Docker Desktop.exe') ? '"Docker Desktop.exe","1234","Console"\r\n' : '');
  }
  return ok('', 1);
};

const wslEnv = {
  WSL_DISTRO_NAME: 'Ubuntu-22.04',
  PATH: '/home/u/.vscode-server/bin/abc/bin/remote-cli:/usr/local/bin:/usr/bin:/mnt/c/Program Files/Docker/Docker/resources/bin',
};
const wslFiles = {
  '/proc/version': 'Linux version 5.15.146.1-microsoft-standard-WSL2',
  '/mnt/c': '',
  '/usr/bin/docker': '',
  '/home/u/.vscode-server/bin/abc/bin/remote-cli/code': '',
  '/mnt/c/Program Files/Docker/Docker/resources/bin/docker': '',
  '/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe': '',
  [`${VSCODE}/Code.exe`]: '',
  [`${VSCODE}/bin/code.cmd`]: CODE_CMD,
  [`${VSCODE}/e646868227/resources/app/out/cli.js`]: '',
};

describe('Linux platform on WSL 2', () => {
  const platform = () => createLinuxPlatform({ env: wslEnv, runner: windowsRunner, ...fakeFs(wslFiles) });

  it('detects WSL', () => {
    expect(isWsl({ env: wslEnv, readText: () => '' })).toBe(true);
    expect(isWsl({ env: {}, readText: () => 'Linux version 6.8.0-generic' })).toBe(false);
  });

  it('uses the docker CLI from the WSL integration, not the Windows shim', async () => {
    expect(await platform().locateDocker()).toEqual({
      cli: '/usr/bin/docker',
      desktopApp: '/mnt/c/Program Files/Docker/Docker/Docker Desktop.exe',
    });
  });

  it('reports no CLI while Docker Desktop is stopped (the integration links disappear)', async () => {
    const files = { ...wslFiles } as Record<string, string>;
    delete files['/usr/bin/docker'];
    const stopped = createLinuxPlatform({ env: wslEnv, runner: windowsRunner, ...fakeFs(files) });
    expect((await stopped.locateDocker()).cli).toBeNull();
    expect(await stopped.isDockerDesktopRunning()).toBe(true);
  });

  it('runs Windows VS Code through interop, passing ELECTRON_RUN_AS_NODE with WSLENV', async () => {
    const cli = (await platform().locateVSCode())!;
    expect(cli.source).toBe('user');
    expect(cli.command).toBe(`${VSCODE}/Code.exe`);
    expect(cli.baseArgs).toEqual(['C:\\Users\\João Silva\\AppData\\Local\\Programs\\Microsoft VS Code\\e646868227\\resources\\app\\out\\cli.js']);
    expect(cli.env.ELECTRON_RUN_AS_NODE).toBe('1');
    expect(cli.env.WSLENV?.split(':')).toContain('ELECTRON_RUN_AS_NODE');
  });

  it('never uses the VS Code Server remote CLI', async () => {
    const files = { ...wslFiles } as Record<string, string>;
    delete files[`${VSCODE}/Code.exe`];
    const noWindowsCode = createLinuxPlatform({ env: wslEnv, runner: windowsRunner, ...fakeFs(files) });
    expect(await noWindowsCode.locateVSCode()).toBeNull();
  });

  it('checks WSL 2 from the kernel and reads the WSL release through interop', async () => {
    expect(await platform().checkWsl()).toMatchObject({ installed: true, version2: true, version: '2.3.24.0' });
    const wsl1 = createLinuxPlatform({ env: wslEnv, runner: windowsRunner, ...fakeFs({ ...wslFiles, '/proc/version': 'Linux version 4.4.0-19041-Microsoft' }) });
    expect(await wsl1.checkWsl()).toMatchObject({ installed: true, version2: false });
  });

  it('opens URLs in the Windows browser and keeps Linux paths for Docker', () => {
    expect(platform().browserCommand('http://127.0.0.1:5173/')).toEqual({ command: '/mnt/c/Windows/explorer.exe', args: ['http://127.0.0.1:5173/'] });
    expect(platform().dockerHostPath('/home/u/.config/Bug Detective/packages/stage-1')).toBe('/home/u/.config/Bug Detective/packages/stage-1');
  });
});

describe('VS Code global storage and host credentials', () => {
  it("on WSL, points the attached-container configuration at the Windows VS Code's globalStorage through /mnt/c", async () => {
    const platform = createLinuxPlatform({ env: wslEnv, runner: windowsRunner, ...fakeFs(wslFiles) });
    expect((await platform.locateVSCode())!.globalStorage).toBe('/mnt/c/Users/João Silva/AppData/Roaming/Code/User/globalStorage');
    // A cmd.exe that answers %APPDATA% too.
    const withAppData = async (command: string, args: readonly string[]) =>
      command.endsWith('cmd.exe') ? ok('C:\\Users\\João Silva\\AppData\\Local|C:\\Program Files|C:\\WINDOWS|D:\\Roaming\r\n') : windowsRunner(command, args);
    expect((await createLinuxPlatform({ env: wslEnv, runner: withAppData, ...fakeFs(wslFiles) }).locateVSCode())!.globalStorage).toBe('/mnt/d/Roaming/Code/User/globalStorage');
  });

  it('on WSL, asks Windows about the OpenSSH agent service and the stored github.com credential', async () => {
    const runner = async (command: string, args: readonly string[]) => {
      if (command.endsWith('sc.exe')) return ok('        STATE              : 4  RUNNING\r\n');
      if (command.endsWith('cmdkey.exe')) return ok('Target: LegacyGeneric:target=git:https://github.com\r\n');
      return windowsRunner(command, args);
    };
    expect(await createLinuxPlatform({ env: wslEnv, runner, ...fakeFs(wslFiles) }).hostCredentials()).toEqual({ sshAgent: true, githubCredential: true });
    expect(await createLinuxPlatform({ env: wslEnv, runner: windowsRunner, ...fakeFs(wslFiles) }).hostCredentials()).toEqual({ sshAgent: false, githubCredential: false });
  });

  it('cannot close VS Code windows yet, so the player is asked to', async () => {
    const platform = createLinuxPlatform({ env: { PATH: '/usr/bin', HOME: '/home/u' }, runner: async () => ok('', 1), ...fakeFs({}) });
    expect(await platform.closeContainerWindows('bugdetective-workspace')).toBe(false);
  });

  it('on plain Linux, uses ~/.config/Code (or XDG_CONFIG_HOME) and only the SSH_AUTH_SOCK of this session', async () => {
    const env = { PATH: '/usr/local/bin:/usr/bin', HOME: '/home/u', SSH_AUTH_SOCK: '/run/user/1000/keyring/ssh' };
    const files = { '/proc/version': 'Linux version 6.8.0-45-generic', '/usr/bin/docker': '', '/usr/bin/code': '' };
    const platform = createLinuxPlatform({ env, runner: async () => ok('', 1), ...fakeFs(files) });
    expect((await platform.locateVSCode())!.globalStorage).toBe('/home/u/.config/Code/User/globalStorage');
    expect(await platform.hostCredentials()).toEqual({ sshAgent: true, githubCredential: false });
    const xdg = createLinuxPlatform({ env: { ...env, XDG_CONFIG_HOME: '/cfg', SSH_AUTH_SOCK: undefined }, runner: async () => ok('', 1), ...fakeFs(files) });
    expect((await xdg.locateVSCode())!.globalStorage).toBe('/cfg/Code/User/globalStorage');
    expect(await xdg.hostCredentials()).toEqual({ sshAgent: false, githubCredential: false });
  });
});

describe('free disk space on WSL 2', () => {
  it("measures the Windows disk that holds Docker Desktop's WSL data", async () => {
    const statfs = async (path: string) => {
      if (path === '/mnt/c/Users/João Silva/AppData/Local/Docker/wsl') return { bsize: 4096, bavail: 2_000_000 };
      throw new Error('ENOENT');
    };
    const platform = createLinuxPlatform({ env: wslEnv, runner: windowsRunner, statfs, ...fakeFs(wslFiles) });
    expect(await platform.freeDiskBytes()).toBe(4096 * 2_000_000);
  });
});

describe('Linux platform on plain Linux', () => {
  const env = { PATH: '/usr/local/bin:/usr/bin' };
  const files = { '/proc/version': 'Linux version 6.8.0-45-generic', '/usr/bin/docker': '', '/usr/bin/code': '' };
  const platform = () => createLinuxPlatform({ env, runner: async () => ok('', 1), ...fakeFs(files) });

  it('uses Docker Engine and VS Code for Linux', async () => {
    expect(await platform().locateDocker()).toEqual({ cli: '/usr/bin/docker', desktopApp: null });
    expect(await platform().locateVSCode()).toMatchObject({ source: 'path', command: '/usr/bin/code', baseArgs: [] });
  });

  it('does not need WSL and uses the default browser opener', async () => {
    expect(await platform().checkWsl()).toMatchObject({ installed: true, version2: true, notNeeded: true });
    expect(platform().browserCommand('http://127.0.0.1:5173/')).toBeNull();
  });

  it("measures the disk of Docker Engine's data folder, or the root file system without one", async () => {
    const statfsOf = (disks: Record<string, number>) => async (path: string) => {
      if (path in disks) return { bsize: 4096, bavail: disks[path] };
      throw new Error('ENOENT');
    };
    expect(await createLinuxPlatform({ env, runner: async () => ok('', 1), statfs: statfsOf({ '/var/lib/docker': 3_000_000, '/': 500 }), ...fakeFs(files) }).freeDiskBytes()).toBe(4096 * 3_000_000);
    expect(await createLinuxPlatform({ env, runner: async () => ok('', 1), statfs: statfsOf({ '/': 500 }), ...fakeFs(files) }).freeDiskBytes()).toBe(4096 * 500);
    const unreadable = createLinuxPlatform({ env, runner: async () => ok('', 1), statfs: async () => { throw new Error('EPERM'); }, ...fakeFs(files) });
    expect(await unreadable.freeDiskBytes()).toBeNull();
  });
});
