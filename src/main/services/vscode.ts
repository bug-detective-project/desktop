/**
 * Opens VS Code attached to the workspace container (Dev Containers "Attach to Running Container"),
 * and manages the Dev Containers extension. Arguments are fixed; nothing comes from user input.
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { VSCodeCli } from '../platform/types.ts';
import { writeFileAtomic } from './content/store.ts';
import type { CommandRunner, RunResult } from './process.ts';

export const DEV_CONTAINERS_EXTENSION = 'ms-vscode-remote.remote-containers';

/**
 * Settings the Dev Containers extension reads when it sets an attached container up, written by
 * the app into the container's machine settings (the vscode-server volume) before every attach:
 * no git credential helper, no copy of the player's .gitconfig, no Docker credential helper, no
 * GitHub CLI token; extensions downloaded by the computer, not from inside the container.
 */
export const VSCODE_MACHINE_SETTINGS: Readonly<Record<string, string | boolean>> = {
  'dev.containers.gitCredentialHelperConfigLocation': 'none',
  'dev.containers.copyGitConfig': false,
  'dev.containers.dockerCredentialHelper': false,
  'dev.containers.githubCLILoginWithToken': false,
  'remote.downloadExtensionsLocally': true,
};

/** The per-container configuration file of the extension (`nameConfigs/<container>.json`): a subset of devcontainer.json. */
export interface AttachedContainerConfig {
  workspaceFolder: string;
  remoteUser: string;
  /** `null` removes a variable from VS Code's environment in the container: the forwarded SSH agent socket is dropped. */
  remoteEnv: Record<string, string | null>;
  settings: Record<string, string | boolean>;
  [key: string]: unknown;
}

/** What the app writes for its workspace container; other keys of an existing file are kept. */
export function attachedContainerConfig(folder: string, existing: Record<string, unknown> = {}): AttachedContainerConfig {
  if (!/^\/workspaces\/[a-z][a-z0-9-]{0,39}$/.test(folder)) {
    throw new Error(`Invalid workspace folder: ${folder}`);
  }
  return {
    ...existing,
    workspaceFolder: folder,
    remoteUser: 'node',
    remoteEnv: { ...((existing.remoteEnv as Record<string, string | null> | undefined) ?? {}), SSH_AUTH_SOCK: null },
    settings: { ...((existing.settings as Record<string, string | boolean> | undefined) ?? {}), ...VSCODE_MACHINE_SETTINGS },
  };
}

/** The extension names the file after the container, escaping `:`, `/` and `%`. */
export function attachedContainerConfigPath(globalStorage: string, containerName: string): string {
  const name = containerName.replace(/[:/%]/g, (char) => `%${char.charCodeAt(0).toString(16)}`);
  return join(globalStorage, DEV_CONTAINERS_EXTENSION, 'nameConfigs', `${name}.json`);
}

/**
 * vscode-remote://attached-container+<hex of {"containerName":"/<name>"}><folder>.
 * The container name and the folder are validated, so the URI can only point at our own container
 * and at a folder of the workspaces volume.
 */
export function attachedContainerUri(containerName: string, folder: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(containerName)) {
    throw new Error(`Invalid container name: ${containerName}`);
  }
  if (!/^\/workspaces\/[a-z][a-z0-9-]{0,39}$/.test(folder)) {
    throw new Error(`Invalid workspace folder: ${folder}`);
  }
  const hex = Buffer.from(JSON.stringify({ containerName: `/${containerName}` }), 'utf8').toString('hex');
  return `vscode-remote://attached-container+${hex}${folder}`;
}

export class VSCode {
  private readonly cli: VSCodeCli;
  private readonly runner: CommandRunner;

  constructor(cli: VSCodeCli, runner: CommandRunner) {
    this.cli = cli;
    this.runner = runner;
  }

  private run(args: string[], timeoutMs = 120_000): Promise<RunResult> {
    return this.runner(this.cli.command, [...this.cli.baseArgs, ...args], { env: this.cli.env, timeoutMs });
  }

  async version(): Promise<string | null> {
    const result = await this.run(['--version'], 30_000);
    return result.code === 0 ? (result.stdout.toString('utf8').split(/\r?\n/)[0] ?? null) : null;
  }

  /** Installed extensions (lowercase ids) and their versions. */
  async listExtensions(): Promise<Map<string, string>> {
    const result = await this.run(['--list-extensions', '--show-versions'], 60_000);
    if (result.code !== 0) {
      throw new Error(`code --list-extensions failed: ${result.stderr.trim()}`);
    }
    const extensions = new Map<string, string>();
    for (const line of result.stdout.toString('utf8').split(/\r?\n/)) {
      const [id, version = ''] = line.trim().toLowerCase().split('@');
      if (id) {
        extensions.set(id, version);
      }
    }
    return extensions;
  }

  /** The installed Dev Containers version, or null when the extension is missing. */
  async devContainersVersion(): Promise<string | null> {
    return (await this.listExtensions()).get(DEV_CONTAINERS_EXTENSION) ?? null;
  }

  async installDevContainers(): Promise<void> {
    const result = await this.run(['--install-extension', DEV_CONTAINERS_EXTENSION], 5 * 60_000);
    if (result.code !== 0) {
      throw new Error(`Installing the Dev Containers extension failed: ${(result.stderr || result.stdout.toString('utf8')).trim()}`);
    }
  }

  /**
   * Writes the per-container configuration file the extension reads when it attaches to our
   * container (never the user's global settings.json): the workspace folder, the `node` user, no
   * SSH agent socket, and the settings the extension copies into the container's machine settings
   * the first time. Keys the file already had are kept.
   */
  async writeAttachedConfig(containerName: string, folder: string): Promise<string> {
    const file = attachedContainerConfigPath(this.cli.globalStorage, containerName);
    let existing: Record<string, unknown> = {};
    if (existsSync(file)) {
      try {
        existing = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
      } catch {
        existing = {};
      }
    }
    await writeFileAtomic(file, `${JSON.stringify(attachedContainerConfig(folder, existing), null, 2)}\n`);
    return file;
  }

  /**
   * Opens VS Code attached to the container, at the workspace folder: in a new window, or with
   * reuseWindow, in the window already open on that folder when there is one.
   */
  async openAttached(containerName: string, folder: string, options: { reuseWindow?: boolean } = {}): Promise<void> {
    const window = options.reuseWindow ? [] : ['--new-window'];
    const result = await this.run([...window, '--folder-uri', attachedContainerUri(containerName, folder)], 60_000);
    if (result.code !== 0) {
      throw new Error(`VS Code could not be opened: ${(result.stderr || result.stdout.toString('utf8')).trim()}`);
    }
  }
}
