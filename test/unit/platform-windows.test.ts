import { describe, expect, it } from 'vitest';
import { createWindowsPlatform, decodeWslOutput, parseWslList, parseWslVersion } from '../../src/main/platform/windows.ts';
import type { RunResult } from '../../src/main/services/process.ts';
import { attachedContainerUri } from '../../src/main/services/vscode.ts';

const CODE_CMD = `@echo off
setlocal
set VSCODE_DEV=
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\\Code.exe" "%~dp0..\\e646868227\\resources\\app\\out\\cli.js" %*
IF %ERRORLEVEL% NEQ 0 EXIT /b %ERRORLEVEL%
endlocal
`;

function fakeFs(files: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(files).map(([path, text]) => [path.toLowerCase(), text]));
  return {
    fileExists: (path: string) => path.toLowerCase() in lower,
    readText: (path: string) => {
      const text = lower[path.toLowerCase()];
      if (text === undefined) throw new Error('ENOENT');
      return text;
    },
  };
}

const ok = (stdout: string | Buffer, code = 0): RunResult => ({ code, stdout: Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout), stderr: '', timedOut: false });

describe('VS Code CLI resolution', () => {
  const user = 'C:\\Users\\João Silva\\AppData\\Local\\Programs\\Microsoft VS Code';
  const system = 'C:\\Program Files\\Microsoft VS Code';
  const env = { LOCALAPPDATA: 'C:\\Users\\João Silva\\AppData\\Local', ProgramFiles: 'C:\\Program Files', PATH: 'C:\\Windows\\System32' };

  it('finds the per-user install and runs Code.exe with the CLI entry point (no cmd.exe)', async () => {
    const platform = createWindowsPlatform({
      env,
      ...fakeFs({
        [`${user}\\bin\\code.cmd`]: CODE_CMD,
        [`${user}\\Code.exe`]: '',
        [`${user}\\e646868227\\resources\\app\\out\\cli.js`]: '',
      }),
    });
    const cli = (await platform.locateVSCode())!;
    expect(cli.source).toBe('user');
    expect(cli.command).toBe(`${user}\\Code.exe`);
    expect(cli.baseArgs).toEqual([`${user}\\e646868227\\resources\\app\\out\\cli.js`]);
    expect(cli.env.ELECTRON_RUN_AS_NODE).toBe('1');
  });

  it('finds the system-wide install with the classic layout', async () => {
    const platform = createWindowsPlatform({
      env,
      ...fakeFs({
        [`${system}\\bin\\code.cmd`]: '@echo off\r\n"%~dp0..\\Code.exe" "%~dp0..\\resources\\app\\out\\cli.js" %*\r\n',
        [`${system}\\Code.exe`]: '',
        [`${system}\\resources\\app\\out\\cli.js`]: '',
      }),
    });
    const cli = (await platform.locateVSCode())!;
    expect(cli.source).toBe('system');
    expect(cli.baseArgs).toEqual([`${system}\\resources\\app\\out\\cli.js`]);
  });

  it('prefers the install on PATH', async () => {
    const custom = 'D:\\Tools\\VS Code';
    const platform = createWindowsPlatform({
      env: { ...env, PATH: `C:\\Windows;"${custom}\\bin"` },
      ...fakeFs({
        [`${custom}\\bin\\code.cmd`]: CODE_CMD,
        [`${custom}\\Code.exe`]: '',
        [`${custom}\\e646868227\\resources\\app\\out\\cli.js`]: '',
        [`${user}\\bin\\code.cmd`]: CODE_CMD,
      }),
    });
    expect((await platform.locateVSCode())!.source).toBe('path');
  });

  it('reports VS Code as missing when only a broken launcher exists', async () => {
    const platform = createWindowsPlatform({ env, ...fakeFs({ [`${user}\\bin\\code.cmd`]: CODE_CMD }) });
    expect(await platform.locateVSCode()).toBeNull();
  });
});

describe('Docker Desktop detection', () => {
  it('finds docker.exe and Docker Desktop in Program Files', async () => {
    const root = 'C:\\Program Files\\Docker\\Docker';
    const platform = createWindowsPlatform({
      env: { ProgramFiles: 'C:\\Program Files', PATH: '' },
      ...fakeFs({ [`${root}\\resources\\bin\\docker.exe`]: '', [`${root}\\Docker Desktop.exe`]: '' }),
    });
    expect(await platform.locateDocker()).toEqual({ cli: `${root}\\resources\\bin\\docker.exe`, desktopApp: `${root}\\Docker Desktop.exe` });
  });

  it('reports Docker as absent', async () => {
    const platform = createWindowsPlatform({ env: { ProgramFiles: 'C:\\Program Files', PATH: '' }, ...fakeFs({}) });
    expect(await platform.locateDocker()).toEqual({ cli: null, desktopApp: null });
  });
});

describe('WSL detection', () => {
  const list = '  NAME              STATE           VERSION\r\n* Ubuntu-22.04      Running         2\r\n  docker-desktop    Stopped         2\r\n';

  it('decodes UTF-16LE output from wsl.exe', () => {
    expect(decodeWslOutput(Buffer.from(`\uFEFF${list}`, 'utf16le'))).toBe(list);
    expect(decodeWslOutput(Buffer.from(list, 'utf8'))).toBe(list);
  });

  it('parses wsl -l -v', () => {
    expect(parseWslList(list)).toEqual([
      { name: 'Ubuntu-22.04', version: 2 },
      { name: 'docker-desktop', version: 2 },
    ]);
  });

  it('checks WSL 2 through exit codes and the distro list, and reads its release', async () => {
    const runner = async (_command: string, args: readonly string[]) =>
      args[0] === '--status'
        ? ok(Buffer.from('Default Version: 2\r\n', 'utf16le'))
        : args[0] === '--version'
          ? ok(Buffer.from('WSL version: 2.3.24.0\r\nKernel version: 5.15.153.1-2\r\n', 'utf16le'))
          : ok(Buffer.from(list, 'utf16le'));
    const platform = createWindowsPlatform({ env: { SystemRoot: 'C:\\Windows' }, runner, ...fakeFs({}) });
    expect(await platform.checkWsl()).toEqual({ installed: true, version2: true, detail: 'Ubuntu-22.04 (WSL 2), docker-desktop (WSL 2)', version: '2.3.24.0' });
  });

  it('reads the WSL release in any language, and nothing from WSL builds without --version', () => {
    expect(parseWslVersion('Versão do WSL: 2.1.5.0\r\nVersão do kernel: 5.15.146.1-2\r\n')).toBe('2.1.5.0');
    expect(parseWslVersion('\r\nWSL-Version: 2.0.9.0\r\n')).toBe('2.0.9.0');
    expect(parseWslVersion('Invalid command line option: --version\r\nUsage: wsl.exe [Argument]\r\n')).toBeNull();
  });

  it('reports WSL as missing when wsl --status fails', async () => {
    const runner = async () => ok('', 1);
    const platform = createWindowsPlatform({ env: {}, runner, ...fakeFs({}) });
    expect(await platform.checkWsl()).toMatchObject({ installed: false, version2: false });
  });

  it('reports WSL 1 only', async () => {
    const runner = async (_command: string, args: readonly string[]) =>
      args[0] === '--status' ? ok('Default Version: 1\n') : ok('  NAME STATE VERSION\n* Legacy Running 1\n');
    const platform = createWindowsPlatform({ env: {}, runner, ...fakeFs({}) });
    expect(await platform.checkWsl()).toMatchObject({ installed: true, version2: false });
  });
});

describe('VS Code global storage and host credentials on Windows', () => {
  const user = 'C:\\Users\\João Silva\\AppData\\Local\\Programs\\Microsoft VS Code';
  const files = fakeFs({ [`${user}\\bin\\code.cmd`]: CODE_CMD, [`${user}\\Code.exe`]: '', [`${user}\\e646868227\\resources\\app\\out\\cli.js`]: '' });

  it("points the attached-container configuration at the user's %APPDATA%\\Code\\User\\globalStorage", async () => {
    const withAppData = createWindowsPlatform({ env: { LOCALAPPDATA: 'C:\\Users\\João Silva\\AppData\\Local', APPDATA: 'C:\\Users\\João Silva\\AppData\\Roaming', PATH: '' }, ...files });
    expect((await withAppData.locateVSCode())!.globalStorage).toBe('C:\\Users\\João Silva\\AppData\\Roaming\\Code\\User\\globalStorage');
    const fromProfile = createWindowsPlatform({ env: { LOCALAPPDATA: 'C:\\Users\\João Silva\\AppData\\Local', USERPROFILE: 'C:\\Users\\João Silva', PATH: '' }, ...files });
    expect((await fromProfile.locateVSCode())!.globalStorage).toBe('C:\\Users\\João Silva\\AppData\\Roaming\\Code\\User\\globalStorage');
  });

  it('reads the OpenSSH agent service and the stored git credential for github.com', async () => {
    const answers = { agent: '        STATE              : 4  RUNNING\r\n', list: 'Target: LegacyGeneric:target=git:https://github.com\r\n    Type: Generic\r\n' };
    const runner = async (command: string, args: readonly string[]) => {
      if (command.endsWith('sc.exe') && args[0] === 'query' && args[1] === 'ssh-agent') return ok(answers.agent);
      if (command.endsWith('cmdkey.exe') && args[0] === '/list') return ok(answers.list);
      return ok('', 1);
    };
    const platform = createWindowsPlatform({ env: { SystemRoot: 'C:\\Windows' }, runner, ...fakeFs({}) });
    expect(await platform.hostCredentials()).toEqual({ sshAgent: true, githubCredential: true });
    answers.agent = '        STATE              : 1  STOPPED\r\n';
    answers.list = 'Target: LegacyGeneric:target=GitHub - https://api.github.com/someone\r\n';
    expect(await platform.hostCredentials()).toEqual({ sshAgent: false, githubCredential: false });
    // SSH_AUTH_SOCK in the environment counts as an agent too; a failed query is no agent and no credential.
    const withSock = createWindowsPlatform({ env: { SystemRoot: 'C:\\Windows', SSH_AUTH_SOCK: '\\\\.\\pipe\\x' }, runner: async () => ok('', 1), ...fakeFs({}) });
    expect(await withSock.hostCredentials()).toEqual({ sshAgent: true, githubCredential: false });
  });
});

describe('closing the VS Code windows of a container', () => {
  const env = { SystemRoot: 'C:\\Windows' };
  const platformAnswering = (result: RunResult) => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const platform = createWindowsPlatform({
      env,
      ...fakeFs({}),
      runner: async (command, args) => {
        calls.push({ command, args });
        return result;
      },
    });
    return { platform, calls };
  };
  const scriptOf = (args: readonly string[]) => Buffer.from(args[args.indexOf('-EncodedCommand') + 1]!, 'base64').toString('utf16le');

  it('asks the windows titled with that container to close, and says none is left', async () => {
    const { platform, calls } = platformAnswering(ok('0\r\n'));
    expect(await platform.closeContainerWindows('bugdetective-workspace')).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(scriptOf(calls[0]!.args)).toContain('[Container bugdetective-workspace');
  });

  it('reports a window that stayed open (unsaved files) or a script that failed', async () => {
    expect(await platformAnswering(ok('1\r\n')).platform.closeContainerWindows('bugdetective-workspace')).toBe(false);
    expect(await platformAnswering(ok('', 1)).platform.closeContainerWindows('bugdetective-workspace')).toBe(false);
  });

  it('never builds the script from a name Docker would refuse', async () => {
    const { platform, calls } = platformAnswering(ok('0'));
    expect(await platform.closeContainerWindows("x'; Remove-Item C:\\ #")).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe('free disk space on Windows', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\João Silva\\AppData\\Local' };
  const dockerDisk = 'C:\\Users\\João Silva\\AppData\\Local\\Docker\\wsl';
  const statfsOf = (disks: Record<string, number>) => async (path: string) => {
    if (path in disks) return { bsize: 4096, bavail: disks[path] };
    throw new Error('ENOENT');
  };

  it("measures the disk that holds Docker Desktop's WSL data, or the local app data when Docker has none yet", async () => {
    const withDocker = createWindowsPlatform({ env, statfs: statfsOf({ [dockerDisk]: 2_500_000, [env.LOCALAPPDATA]: 1_000 }), ...fakeFs({}) });
    expect(await withDocker.freeDiskBytes()).toBe(4096 * 2_500_000);
    const fresh = createWindowsPlatform({ env, statfs: statfsOf({ [env.LOCALAPPDATA]: 1_000 }), ...fakeFs({}) });
    expect(await fresh.freeDiskBytes()).toBe(4096 * 1_000);
  });

  it('answers null when the space cannot be read', async () => {
    const platform = createWindowsPlatform({ env: {}, statfs: async () => { throw new Error('EPERM'); }, ...fakeFs({}) });
    expect(await platform.freeDiskBytes()).toBeNull();
  });
});

describe('attached-container URI', () => {
  it('hex-encodes the container name JSON', () => {
    const uri = attachedContainerUri('bugdetective-workspace', '/workspaces/supportdesk');
    const hex = /^vscode-remote:\/\/attached-container\+([0-9a-f]+)\/workspaces\/supportdesk$/.exec(uri)![1];
    expect(JSON.parse(Buffer.from(hex, 'hex').toString())).toEqual({ containerName: '/bugdetective-workspace' });
  });

  it('only accepts valid container names', () => {
    expect(() => attachedContainerUri('x" --evil', '/workspaces/supportdesk')).toThrow();
    expect(() => attachedContainerUri('../x', '/workspaces/supportdesk')).toThrow();
  });
});
