/** The first-run checklist: Docker Desktop, WSL2, VS Code and the Dev Containers extension. */
import type { CheckResult, EngineState, PrerequisiteReport } from '../../shared/api.ts';
import type { Platform, VSCodeCli, WslStatus } from '../platform/types.ts';
import { Docker } from './docker.ts';
import { VSCode } from './vscode.ts';

export interface Environment {
  docker: Docker | null;
  dockerDesktopApp: string | null;
  vscode: VSCode | null;
  vscodeCli: VSCodeCli | null;
}

/** Below this, the engine (WSL 2's memory, see .wslconfig) is likely too small for the workspace and the QA runs. */
export const MIN_ENGINE_MEMORY_BYTES = 4 * 1024 ** 3;

export class Prerequisites {
  private readonly platform: Platform;

  constructor(platform: Platform) {
    this.platform = platform;
  }

  async locate(): Promise<Environment> {
    const docker = await this.platform.locateDocker();
    const vscodeCli = await this.platform.locateVSCode();
    return {
      docker: docker.cli ? new Docker(docker.cli, this.platform.runner) : null,
      dockerDesktopApp: docker.desktopApp,
      vscode: vscodeCli ? new VSCode(vscodeCli, this.platform.runner) : null,
      vscodeCli,
    };
  }

  /** Distinguishes not installed, installed but stopped, starting and running. */
  async dockerState(environment: Environment): Promise<EngineState> {
    if (!environment.docker) {
      return environment.dockerDesktopApp ? 'notRunning' : 'notInstalled';
    }
    if (await environment.docker.serverVersion()) {
      return 'running';
    }
    if (!environment.dockerDesktopApp) {
      // Docker Engine (Linux): the CLI is there but the daemon does not answer.
      return 'notRunning';
    }
    return (await this.platform.isDockerDesktopRunning()) ? 'starting' : 'notRunning';
  }

  async check(environment?: Environment): Promise<PrerequisiteReport> {
    const env = environment ?? (await this.locate());
    // Versions are extra information: a failure to read one never fails a check.
    const [dockerState, dockerVersion, dockerInfo, wsl, vscodeVersion, devcontainers, host] = await Promise.all([
      this.dockerState(env),
      env.docker?.versionInfo().catch(() => null) ?? Promise.resolve(null),
      env.docker?.serverInfo().catch(() => null) ?? Promise.resolve(null),
      this.platform.checkWsl().catch((error: Error): WslStatus => ({ installed: false, version2: false, detail: error.message })),
      env.vscode?.version().catch(() => null) ?? Promise.resolve(null),
      // undefined: the extensions could not be listed.
      env.vscode?.devContainersVersion().catch(() => undefined) ?? Promise.resolve(undefined),
      // What an attached VS Code could still carry into the container (a warning, never a failure).
      env.vscodeCli ? this.platform.hostCredentials().catch(() => null) : Promise.resolve(null),
    ]);
    const vscodeWarnings = [...(host?.sshAgent ? ['sshAgent'] : []), ...(host?.githubCredential ? ['githubCredential'] : [])];
    const version = (value: string | null | undefined) => (value ? { version: value } : {});
    const dockerCheck = (): CheckResult => {
      if (dockerState !== 'running') {
        return { id: 'docker', status: dockerState === 'starting' ? 'pending' : 'missing', reason: dockerState };
      }
      const docker = version(dockerVersion && (dockerVersion.desktop ?? dockerVersion.engine));
      // Docker Desktop switched to Windows containers: the Linux images cannot be built or run.
      if (dockerInfo && dockerInfo.osType !== 'linux') {
        return { id: 'docker', status: 'missing', reason: 'windowsContainers', ...docker };
      }
      if (dockerInfo && dockerInfo.memTotalBytes < MIN_ENGINE_MEMORY_BYTES) {
        return { id: 'docker', status: 'ok', warnings: ['lowMemory'], ...docker };
      }
      return { id: 'docker', status: 'ok', ...docker };
    };
    const checks: CheckResult[] = [
      dockerCheck(),
      !wsl.installed
        ? { id: 'wsl', status: 'missing', reason: 'notFound', detail: wsl.detail }
        : wsl.version2
          ? { id: 'wsl', status: 'ok', detail: wsl.detail, ...(wsl.notNeeded && { reason: 'notNeeded' }), ...version(wsl.version) }
          : { id: 'wsl', status: 'missing', reason: 'wsl1Only', detail: wsl.detail, ...version(wsl.version) },
      env.vscodeCli
        ? { id: 'vscode', status: 'ok', detail: env.vscodeCli.launcher, ...version(vscodeVersion), ...(vscodeWarnings.length > 0 && { warnings: vscodeWarnings }) }
        : { id: 'vscode', status: 'missing', reason: 'cliNotFound' },
      typeof devcontainers === 'string'
        ? { id: 'devcontainers', status: 'ok', ...version(devcontainers) }
        : {
            id: 'devcontainers',
            status: 'missing',
            reason: devcontainers === undefined && env.vscode ? 'checkFailed' : 'extensionMissing',
          },
    ];
    return { checks, allOk: checks.every((check) => check.status === 'ok'), dockerState };
  }

  /** Starts Docker Desktop and polls until the engine answers, or the timeout passes. */
  async startDocker(environment: Environment, timeoutMs = 180_000, onPoll?: (state: EngineState) => void): Promise<EngineState> {
    if (!environment.dockerDesktopApp) {
      return 'notInstalled';
    }
    if ((await this.dockerState(environment)) === 'running') {
      return 'running';
    }
    await this.platform.startDockerDesktop(environment.dockerDesktopApp);
    const deadline = Date.now() + timeoutMs;
    let located = environment;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      // The CLI may only appear on PATH after the first start.
      if (!located.docker) {
        located = { ...located, ...(await this.locate()) };
      }
      const state = await this.dockerState(located);
      onPoll?.(state);
      if (state === 'running') {
        return state;
      }
    }
    return this.dockerState(located);
  }
}
