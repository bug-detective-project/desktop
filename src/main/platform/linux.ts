/**
 * Linux implementation of the platform module. Two cases:
 *   - WSL 2 (the main target): Docker Desktop's WSL integration provides `docker`; Docker Desktop
 *     itself, VS Code and the browser are Windows programs, reached through WSL interop.
 *   - Plain Linux: Docker Engine and VS Code for Linux.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import { createServer } from 'node:net';
import { posix as path, win32 } from 'node:path';
import { runCommand } from '../services/process.ts';
import type { CommandRunner } from '../services/process.ts';
import { freeBytesOf, hasGitHubCredential, serviceRunning } from './types.ts';
import type { DockerLocations, HostCredentials, Platform, StatFs, VSCodeCli, WslStatus } from './types.ts';
import { decodeWslOutput, parseWslVersion } from './windows.ts';

export interface LinuxDeps {
  env: NodeJS.ProcessEnv;
  runner: CommandRunner;
  fileExists: (file: string) => boolean;
  readText: (file: string) => string;
  statfs: StatFs;
}

const defaultDeps = (): LinuxDeps => ({
  env: process.env,
  runner: runCommand,
  fileExists: existsSync,
  readText: (file) => readFileSync(file, 'utf8'),
  statfs,
});

/** True inside WSL (any version). */
export function isWsl(deps: Pick<LinuxDeps, 'env' | 'readText'>): boolean {
  if (deps.env.WSL_DISTRO_NAME) {
    return true;
  }
  try {
    return /microsoft/i.test(deps.readText('/proc/version'));
  } catch {
    return false;
  }
}

function findOnPath(deps: LinuxDeps, file: string, accept: (candidate: string) => boolean = () => true): string | null {
  for (const dir of (deps.env.PATH ?? '').split(':').filter(Boolean)) {
    const candidate = path.join(dir, file);
    if (accept(candidate) && deps.fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
}

interface WindowsSide {
  /** %LOCALAPPDATA%, %APPDATA% and %ProgramFiles% as Windows paths. */
  localAppData: string;
  appData: string;
  programFiles: string;
  /** Converts a Windows path to its /mnt/... path. */
  toLinux: (windowsPath: string) => string;
  system32: string;
}

export function createLinuxPlatform(overrides: Partial<LinuxDeps> = {}): Platform {
  const deps = { ...defaultDeps(), ...overrides };
  const { env, runner } = deps;
  const wsl = isWsl(deps);
  let windowsSide: Promise<WindowsSide | null> | null = null;

  /** Windows folders, read once through interop (WSL only). */
  const windows = () => {
    windowsSide ??= (async () => {
      if (!wsl) {
        return null;
      }
      const cmd = '/mnt/c/Windows/System32/cmd.exe';
      const result = await runner(cmd, ['/d', '/c', 'echo %LOCALAPPDATA%^|%ProgramFiles%^|%SystemRoot%^|%APPDATA%'], {
        cwd: deps.fileExists('/mnt/c') ? '/mnt/c' : undefined,
        timeoutMs: 15_000,
      });
      const [localAppData, programFiles, systemRoot, appDataRaw] = result.stdout.toString('utf8').trim().split('|');
      if (result.code !== 0 || !localAppData || !programFiles || !systemRoot) {
        return null;
      }
      // Older callers answer without %APPDATA%: it is next to %LOCALAPPDATA% (…\AppData\Roaming).
      const appData = appDataRaw && appDataRaw !== '%APPDATA%' ? appDataRaw : win32.join(win32.dirname(localAppData), 'Roaming');
      // Same mapping as wslpath with the default automount root (/mnt).
      const toLinux = (windowsPath: string) => {
        const match = /^([A-Za-z]):\\?(.*)$/.exec(windowsPath);
        return match ? path.join('/mnt', match[1].toLowerCase(), ...match[2].split('\\').filter(Boolean)) : windowsPath;
      };
      return { localAppData, appData, programFiles, toLinux, system32: toLinux(win32.join(systemRoot, 'System32')) };
    })();
    return windowsSide;
  };

  /** Windows VS Code, run from WSL: Code.exe with the CLI entry point, like bin\code.cmd does. */
  async function windowsVSCode(): Promise<VSCodeCli | null> {
    const side = await windows();
    if (!side) {
      return null;
    }
    const roots: [string, VSCodeCli['source']][] = [
      [win32.join(side.localAppData, 'Programs', 'Microsoft VS Code'), 'user'],
      [win32.join(side.programFiles, 'Microsoft VS Code'), 'system'],
    ];
    for (const [root, source] of roots) {
      const launcher = win32.join(root, 'bin', 'code.cmd');
      const exe = side.toLinux(win32.join(root, 'Code.exe'));
      if (!deps.fileExists(exe) || !deps.fileExists(side.toLinux(launcher))) {
        continue;
      }
      let cliJs = win32.join(root, 'resources', 'app', 'out', 'cli.js');
      const match = /"%~dp0\.\.\\([^"]*?cli\.js)"/i.exec(deps.readText(side.toLinux(launcher)));
      if (match) {
        cliJs = win32.join(root, match[1]);
      }
      if (!deps.fileExists(side.toLinux(cliJs))) {
        continue;
      }
      // WSLENV passes ELECTRON_RUN_AS_NODE on to the Windows process.
      const wslenv = ['ELECTRON_RUN_AS_NODE', ...(env.WSLENV ?? '').split(':').filter(Boolean)].join(':');
      const childEnv: NodeJS.ProcessEnv = { ...env, ELECTRON_RUN_AS_NODE: '1', WSLENV: wslenv };
      delete childEnv.VSCODE_DEV;
      return { source, launcher, command: exe, baseArgs: [cliJs], env: childEnv, globalStorage: side.toLinux(win32.join(side.appData, 'Code', 'User', 'globalStorage')) };
    }
    return null;
  }

  /** VS Code for Linux. The remote CLI of a VS Code Server (inside a VS Code terminal) is skipped. */
  function linuxVSCode(): VSCodeCli | null {
    const accept = (candidate: string) => !candidate.includes('/.vscode-server/') && !candidate.startsWith('/mnt/');
    const launcher =
      findOnPath(deps, 'code', accept) ??
      ['/usr/bin/code', '/usr/share/code/bin/code', '/snap/bin/code'].find((file) => deps.fileExists(file)) ??
      null;
    const configHome = env.XDG_CONFIG_HOME || path.join(env.HOME ?? '/root', '.config');
    return launcher ? { source: 'path', launcher, command: launcher, baseArgs: [], env: { ...env }, globalStorage: path.join(configHome, 'Code', 'User', 'globalStorage') } : null;
  }

  return {
    id: 'linux',
    runner,

    async locateDocker(): Promise<DockerLocations> {
      // On WSL, the Docker Desktop shim in the Windows PATH only prints a hint; skip it.
      const cli = findOnPath(deps, 'docker', (candidate) => !candidate.startsWith('/mnt/'));
      const side = await windows();
      const desktop = side && side.toLinux(win32.join(side.programFiles, 'Docker', 'Docker', 'Docker Desktop.exe'));
      return { cli, desktopApp: desktop && deps.fileExists(desktop) ? desktop : null };
    },

    async isDockerDesktopRunning() {
      const side = await windows();
      if (!side) {
        return false;
      }
      const result = await runner(path.join(side.system32, 'tasklist.exe'), ['/FI', 'IMAGENAME eq Docker Desktop.exe', '/FO', 'CSV', '/NH'], {
        timeoutMs: 10_000,
      });
      return result.code === 0 && result.stdout.toString('utf8').toLowerCase().includes('docker desktop.exe');
    },

    async startDockerDesktop(desktopApp) {
      const child = spawn(desktopApp, [], { detached: true, stdio: 'ignore', shell: false, cwd: '/mnt/c' });
      child.on('error', () => {});
      child.unref();
    },

    async checkWsl(): Promise<WslStatus> {
      if (!wsl) {
        return { installed: true, version2: true, detail: 'Not needed on Linux', notNeeded: true };
      }
      let kernel = '';
      try {
        kernel = deps.readText('/proc/version');
      } catch {
        // Fall through: WSL_DISTRO_NAME was set.
      }
      // WSL 1 has no real Linux kernel; its /proc/version says "Microsoft" without "WSL2".
      const version2 = /WSL2|microsoft-standard/i.test(kernel);
      const side = await windows();
      const release = side ? await runner(path.join(side.system32, 'wsl.exe'), ['--version'], { timeoutMs: 15_000 }) : null;
      const version = release?.code === 0 ? parseWslVersion(decodeWslOutput(release.stdout)) : null;
      return { installed: true, version2, detail: `${env.WSL_DISTRO_NAME ?? 'WSL'} (WSL ${version2 ? 2 : 1})`, ...(version && { version }) };
    },

    async locateVSCode() {
      return (wsl ? await windowsVSCode() : null) ?? linuxVSCode();
    },

    dockerHostPath(hostPath) {
      // Docker Desktop's WSL integration and Docker Engine both accept Linux paths.
      return path.resolve(hostPath);
    },

    isPortFree(port) {
      return new Promise((resolve) => {
        const server = createServer();
        server.once('error', () => resolve(false));
        server.listen({ port, host: '127.0.0.1', exclusive: true }, () => server.close(() => resolve(true)));
      });
    },

    browserCommand(url) {
      // On WSL, open the Windows default browser; the published ports answer on Windows too.
      return wsl ? { command: '/mnt/c/Windows/explorer.exe', args: [url] } : null;
    },

    // No way to list windows here yet, so the app asks the player to close it.
    async closeContainerWindows() {
      return false;
    },

    async hostCredentials(): Promise<HostCredentials> {
      const side = await windows();
      if (!side) {
        // Plain Linux: only the agent of this session is known; stored git credentials are not probed (a helper could prompt).
        return { sshAgent: Boolean(env.SSH_AUTH_SOCK), githubCredential: false };
      }
      // WSL: the Windows VS Code attaches, so the Windows agent service and credential store count, and the WSL agent too.
      const agent = await runner(path.join(side.system32, 'sc.exe'), ['query', 'ssh-agent'], { timeoutMs: 10_000 });
      const stored = await runner(path.join(side.system32, 'cmdkey.exe'), ['/list'], { timeoutMs: 10_000 });
      return {
        sshAgent: Boolean(env.SSH_AUTH_SOCK) || (agent.code === 0 && serviceRunning(agent.stdout.toString('utf8'))),
        githubCredential: stored.code === 0 && hasGitHubCredential(stored.stdout.toString('utf8')),
      };
    },

    async freeDiskBytes() {
      // WSL 2: Docker Desktop's disk lives on Windows (%LOCALAPPDATA%\Docker\wsl). Plain Linux: Docker Engine's data folder, or the root file system.
      const side = await windows();
      const candidates = side ? [side.toLinux(win32.join(side.localAppData, 'Docker', 'wsl')), side.toLinux(side.localAppData)] : ['/var/lib/docker', '/'];
      return freeBytesOf(deps.statfs, candidates);
    },
  };
}
