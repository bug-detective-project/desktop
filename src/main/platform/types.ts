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
