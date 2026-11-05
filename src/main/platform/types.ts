/**
 * Everything that differs between operating systems lives behind this interface.
 * Implemented for Windows (windows.ts) and Linux, including WSL 2 (linux.ts); macOS comes later.
 */
import type { CommandRunner } from '../services/process.ts';

export interface VSCodeCli {
  /** Where it was found: on PATH, the per-user install or the system-wide install. */
  source: 'path' | 'user' | 'system';
  /** The bin/code.cmd (or equivalent) that was resolved. */
  launcher: string;
  /** The executable to spawn and the arguments that precede the CLI arguments. */
  command: string;
  baseArgs: string[];
  env: NodeJS.ProcessEnv;
  /**
   * That VS Code's `User/globalStorage` folder, as a path this process can write (the Windows
   * folder through /mnt/c from WSL): the Dev Containers extension keeps its per-container
   * configuration files there (`ms-vscode-remote.remote-containers/nameConfigs/`).
   */
  globalStorage: string;
}

/** What the Dev Containers extension would carry into an attached container from this computer, beyond what the app turns off. */
export interface HostCredentials {
  /** An SSH agent runs (SSH_AUTH_SOCK set, or the Windows OpenSSH agent service): the extension forwards it. */
  sshAgent: boolean;
  /** A git credential for github.com is stored on the computer (the Windows Credential Manager): the extension's helper channel can hand it to the container. */
  githubCredential: boolean;
}

export interface WslStatus {
  installed: boolean;
  /** True when WSL 2 is available (a version 2 distro exists, or the default version is 2). */
  version2: boolean;
  detail: string;
  /** The WSL release from `wsl --version` (for example 2.3.24.0); older WSL builds do not report one. */
  version?: string;
  /** Plain Linux: WSL does not apply. */
  notNeeded?: boolean;
}

export interface DockerLocations {
  /** The docker CLI, or null when it cannot be found. */
  cli: string | null;
  /** The Docker Desktop application, or null when it is not installed. */
  desktopApp: string | null;
}

export interface Platform {
  readonly id: 'windows' | 'linux';
  readonly runner: CommandRunner;
  locateDocker(): Promise<DockerLocations>;
  /** True when the Docker Desktop process is running (the engine may still be starting). */
  isDockerDesktopRunning(): Promise<boolean>;
  startDockerDesktop(desktopApp: string): Promise<void>;
  checkWsl(): Promise<WslStatus>;
  locateVSCode(): Promise<VSCodeCli | null>;
  /** Converts a host path for use as a docker bind-mount source. */
  dockerHostPath(path: string): string;
  isPortFree(port: number): Promise<boolean>;
  /** A command that opens a URL in the user's browser, or null to use Electron's shell.openExternal. */
  browserCommand(url: string): { command: string; args: string[] } | null;
  /** Free bytes on the disk that holds Docker's data (images, volumes, build cache), or null when it cannot be measured. */
  freeDiskBytes(): Promise<number | null>;
  /** The credentials an attached VS Code could carry into the container from this computer (the checklist warns about them). */
  hostCredentials(): Promise<HostCredentials>;
  /** Closes the VS Code windows attached to a container: true when none is left, false when it cannot tell (see attached-window.ts). */
  closeContainerWindows(containerName: string): Promise<boolean>;
}

/** `sc query ssh-agent` says the Windows OpenSSH agent service is running. */
export function serviceRunning(scQueryOutput: string): boolean {
  return /STATE\s*:\s*\d+\s+RUNNING/i.test(scQueryOutput);
}

/** `cmdkey /list` lists a git credential for github.com (what the Git Credential Manager stores). */
export function hasGitHubCredential(cmdkeyListOutput: string): boolean {
  return /git:https:\/\/github\.com/i.test(cmdkeyListOutput);
}

/** The part of `fs.statfs` the platforms use. */
export type StatFs = (path: string) => Promise<{ bsize: number; bavail: number }>;

/** `bavail × bsize` of the first candidate path `statfs` answers for (a missing folder falls through to the next), or null when none does. */
export async function freeBytesOf(statfs: StatFs, candidates: readonly string[]): Promise<number | null> {
  for (const candidate of candidates) {
    try {
      const stats = await statfs(candidate);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch {
      // Not there, or not readable: try the next one.
    }
  }
  return null;
}
