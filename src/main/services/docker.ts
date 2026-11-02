/**
 * Thin wrapper around the docker CLI. Every call is an argument array; resources created by the
 * app carry the `bugdetective.role` label so cleanup never touches anything else.
 */
import type { Readable } from 'node:stream';
import type { LabelledResources } from './cleanup.ts';
import { CommandError, runChecked } from './process.ts';
import type { CommandRunner, RunOptions, RunResult } from './process.ts';

export const LABEL = 'bugdetective.role';
/** The game project a resource belongs to (its code, dependencies and QA image). Only one project stays in Docker. */
export const PROJECT_LABEL = 'bugdetective.project';

/** `--label` arguments for a resource: its role, and its project when it belongs to one. */
export function labelArgs(role: string, project?: string | null): string[] {
  return ['--label', `${LABEL}=${role}`, ...(project ? ['--label', `${PROJECT_LABEL}=${project}`] : [])];
}

export type { EngineState } from '../../shared/api.ts';

export interface ContainerInfo {
  name: string;
  running: boolean;
  image: string;
  /** Published host ports by container port, for example { 15173: 5173 }. */
  ports: Record<number, number>;
  labels: Record<string, string>;
}

export interface ExecOptions {
  user?: string;
  workdir?: string;
  env?: Record<string, string>;
  input?: Uint8Array | string | Readable;
  timeoutMs?: number;
  signal?: AbortSignal;
  onLine?: RunOptions['onLine'];
  maxStdout?: number;
}

export class DockerUnavailableError extends Error {
  constructor(message = 'Docker is not running') {
    super(message);
  }
}

export class Docker {
  readonly cli: string;
  private readonly runner: CommandRunner;

  constructor(cli: string, runner: CommandRunner) {
    this.cli = cli;
    this.runner = runner;
  }

  run(args: readonly string[], options?: RunOptions): Promise<RunResult> {
    return this.runner(this.cli, args, options);
  }

  checked(args: readonly string[], options?: RunOptions): Promise<RunResult> {
    return runChecked(this.runner, this.cli, args, options);
  }

  /** The engine version, or null when the engine does not answer. */
  async serverVersion(timeoutMs = 15_000): Promise<string | null> {
    const result = await this.run(['version', '--format', '{{.Server.Version}}'], { timeoutMs });
    const version = result.stdout.toString('utf8').trim();
    return result.code === 0 && version ? version : null;
  }

  /** The engine version and, under Docker Desktop, the Desktop release; null when the engine does not answer. */
  async versionInfo(timeoutMs = 15_000): Promise<{ engine: string; desktop: string | null } | null> {
    const result = await this.run(['version', '--format', '{{.Server.Version}}|{{.Server.Platform.Name}}'], { timeoutMs });
    const [engine, platform = ''] = result.stdout.toString('utf8').trim().split('|');
    if (result.code !== 0 || !engine) {
      return null;
    }
    return { engine, desktop: /Docker Desktop (\d+\.\d+\.\d+)/.exec(platform)?.[1] ?? null };
  }

  /** Size of an image in bytes, or null when it does not exist. */
  async imageSize(tag: string): Promise<number | null> {
    const result = await this.run(['image', 'inspect', '--format', '{{.Size}}', tag], { timeoutMs: 30_000 });
    const size = Number(result.stdout.toString('utf8').trim());
    return result.code === 0 && Number.isFinite(size) ? size : null;
  }

  /** Sizes in bytes of the given volumes that exist (`docker system df -v` measures them, which takes a few seconds). */
  async volumeSizes(names: readonly string[]): Promise<Record<string, number>> {
    const result = await this.checked(['system', 'df', '--verbose', '--format', '{{json .Volumes}}'], { timeoutMs: 120_000 });
    const volumes = JSON.parse(result.stdout.toString('utf8').trim() || '[]') as { Name: string; Size: string }[] | null;
    const sizes: Record<string, number> = {};
    for (const volume of volumes ?? []) {
      const bytes = parseDockerSize(volume.Size);
      if (names.includes(volume.Name) && bytes !== null) {
        sizes[volume.Name] = bytes;
      }
    }
    return sizes;
  }

  async imageExists(tag: string): Promise<boolean> {
    return (await this.run(['image', 'inspect', '--format', '{{.Id}}', tag], { timeoutMs: 30_000 })).code === 0;
  }

  async build(contextDir: string, tag: string, role: string, onLine?: RunOptions['onLine'], signal?: AbortSignal, project?: string | null) {
    await this.checked(['build', '--progress', 'plain', ...labelArgs(role, project), '--tag', tag, contextDir], {
      onLine,
      signal,
    });
  }

  async volumeExists(name: string): Promise<boolean> {
    return (await this.run(['volume', 'inspect', name], { timeoutMs: 30_000 })).code === 0;
  }

  async createVolume(name: string, role: string, project?: string | null): Promise<void> {
    if (!(await this.volumeExists(name))) {
      await this.checked(['volume', 'create', ...labelArgs(role, project), name]);
    }
  }

  async removeVolume(name: string): Promise<void> {
    const result = await this.run(['volume', 'rm', '--force', name], { timeoutMs: 60_000 });
    if (result.code !== 0 && (await this.volumeExists(name))) {
      throw new CommandError(this.cli, ['volume', 'rm', name], result);
    }
  }

  async inspectContainer(name: string): Promise<ContainerInfo | null> {
    const result = await this.run(['container', 'inspect', name], { timeoutMs: 30_000 });
    if (result.code !== 0) {
      return null;
    }
    const [raw] = JSON.parse(result.stdout.toString('utf8')) as {
      Name: string;
      State: { Running: boolean };
      Config: { Image: string; Labels: Record<string, string> | null };
      HostConfig: { PortBindings: Record<string, { HostPort: string }[] | null> | null };
    }[];
    const ports: Record<number, number> = {};
    for (const [key, bindings] of Object.entries(raw.HostConfig.PortBindings ?? {})) {
      const hostPort = Number(bindings?.[0]?.HostPort);
      if (hostPort) {
        ports[Number.parseInt(key, 10)] = hostPort;
      }
    }
    return {
      name: raw.Name.replace(/^\//, ''),
      running: raw.State.Running,
      image: raw.Config.Image,
      ports,
      labels: raw.Config.Labels ?? {},
    };
  }

  async removeContainer(name: string): Promise<void> {
    await this.run(['container', 'rm', '--force', '--volumes=false', name], { timeoutMs: 60_000 });
  }

  /** Removes an image by tag or id. Without force, an image a container still uses is kept (and this throws). */
  async removeImage(ref: string, options: { force?: boolean } = {}): Promise<void> {
    await this.checked(['image', 'rm', ...(options.force ? ['--force'] : []), ref], { timeoutMs: 120_000 });
  }

  /** Every container, volume and image carrying the app's label, whatever its role. */
  async labelled(): Promise<LabelledResources> {
    const filter = ['--filter', `label=${LABEL}`];
    const lines = (result: RunResult) => result.stdout.toString('utf8').split(/\r?\n/).filter(Boolean);
    const [containers, volumes, images] = await Promise.all([
      this.checked(['container', 'ls', '--all', ...filter, '--format', '{{.Names}}'], { timeoutMs: 30_000 }),
      this.checked(['volume', 'ls', ...filter, '--format', '{{.Name}}'], { timeoutMs: 30_000 }),
      this.checked(['image', 'ls', ...filter, '--format', '{{.Repository}}:{{.Tag}}|{{.ID}}'], { timeoutMs: 30_000 }),
    ]);
    return {
      containers: lines(containers),
      volumes: lines(volumes),
      images: lines(images).map((line) => {
        const [ref = '', id = ''] = line.split('|');
        return { ref, id };
      }),
    };
  }

  /** Every container, volume and image of one game project. */
  async ofProject(project: string): Promise<LabelledResources> {
    const filter = ['--filter', `label=${PROJECT_LABEL}=${project}`];
    const lines = (result: RunResult) => result.stdout.toString('utf8').split(/\r?\n/).filter(Boolean);
    const [containers, volumes, images] = await Promise.all([
      this.checked(['container', 'ls', '--all', ...filter, '--format', '{{.Names}}'], { timeoutMs: 30_000 }),
      this.checked(['volume', 'ls', ...filter, '--format', '{{.Name}}'], { timeoutMs: 30_000 }),
      this.checked(['image', 'ls', ...filter, '--format', '{{.Repository}}:{{.Tag}}|{{.ID}}'], { timeoutMs: 30_000 }),
    ]);
    return {
      containers: lines(containers),
      volumes: lines(volumes),
      images: lines(images).map((line) => {
        const [ref = '', id = ''] = line.split('|');
        return { ref, id };
      }),
    };
  }

  /** Names of containers carrying the given role label (running or not). */
  async containersWithRole(role: string): Promise<string[]> {
    const result = await this.checked(['container', 'ls', '--all', '--filter', `label=${LABEL}=${role}`, '--format', '{{.Names}}']);
    return result.stdout.toString('utf8').split(/\r?\n/).filter(Boolean);
  }

  exec(container: string, command: readonly string[], options: ExecOptions = {}): Promise<RunResult> {
    const args = ['exec'];
    if (options.input !== undefined) {
      args.push('--interactive');
    }
    if (options.user) {
      args.push('--user', options.user);
    }
    if (options.workdir) {
      args.push('--workdir', options.workdir);
    }
    for (const [name, value] of Object.entries(options.env ?? {})) {
      args.push('--env', `${name}=${value}`);
    }
    args.push(container, ...command);
    return this.run(args, {
      input: options.input,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      onLine: options.onLine,
      maxStdout: options.maxStdout,
    });
  }

  async execChecked(container: string, command: readonly string[], options: ExecOptions = {}): Promise<RunResult> {
    const result = await this.exec(container, command, options);
    if (result.code !== 0) {
      throw new CommandError(this.cli, ['exec', container, ...command], result);
    }
    return result;
  }
}

const SIZE_UNITS: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12 };

/** Parses the sizes docker prints ("80.31MB", "1.2GB", "0B"; decimal units). Null for "N/A". */
export function parseDockerSize(text: string): number | null {
  const match = /^([\d.]+)\s*([kKMGT]?B)$/.exec(text.trim());
  return match ? Math.round(Number(match[1]) * SIZE_UNITS[match[2].toUpperCase()]) : null;
}

/** Formats one `--mount` value. Fields with commas or quotes are quoted CSV-style, as docker expects. */
export function mountArg(fields: Record<string, string | true>): string {
  return Object.entries(fields)
    .map(([key, value]) => {
      const field = value === true ? key : `${key}=${value}`;
      return /[",]/.test(field) ? `"${field.replaceAll('"', '""')}"` : field;
    })
    .join(',');
}
