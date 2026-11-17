/**
 * The services of one QA run. A project that declares services gets, for every run, a fresh copy
 * of each one on an internal network of that run alone, with the data in memory: the run never
 * sees the player's services or data, has no internet, and leaves no volume behind. Everything
 * carries the roles `qa-service` and `qa-network`, so a crash is swept from Docker's own listing.
 */
import { SERVICE_READY_TIMEOUT_MS, serviceImageOf, serviceRunArgs, serviceVariables } from '@bug-detective/catalog/contract';
import type { ProjectServices as Declared } from '@bug-detective/catalog/contract';
import { LABEL, PROJECT_LABEL } from './docker.ts';
import type { Docker } from './docker.ts';

export const QA_SERVICE_ROLE = 'qa-service';
export const QA_NETWORK_ROLE = 'qa-network';

/** The network of a QA run and the container of each of its services. */
export function qaServiceNames(prefix: string, project: string, run: string, services: Declared): { network: string; containers: Record<string, string> } {
  return {
    network: `${prefix}-qanet-${project}-${run}`,
    containers: Object.fromEntries(Object.keys(services).map((service) => [service, `${prefix}-qasvc-${project}-${service}-${run}`])),
  };
}

/** A service of a QA run did not come up; the message names it and carries Docker's or the server's reason. */
export class QaServiceError extends Error {}

export interface QaServicesOptions {
  docker: Docker;
  prefix: string;
  project: string;
  services: Declared;
  readyTimeoutMs?: number;
  pollMs?: number;
}

const lastLine = (text: string): string =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) ?? '';

export class QaServices {
  private readonly docker: Docker;
  private readonly prefix: string;
  private readonly project: string;
  private readonly services: Declared;
  private readonly readyTimeoutMs: number;
  private readonly pollMs: number;

  constructor(options: QaServicesOptions) {
    this.docker = options.docker;
    this.prefix = options.prefix;
    this.project = options.project;
    this.services = options.services;
    this.readyTimeoutMs = options.readyTimeoutMs ?? SERVICE_READY_TIMEOUT_MS;
    this.pollMs = options.pollMs ?? 200;
  }

  get declared(): boolean {
    return Object.keys(this.services).length > 0;
  }

  /**
   * Creates the run's network and starts every service on it, waiting until each accepts
   * connections. Returns the network for the QA container and the variables for its code. On any
   * failure everything of the run is removed and a QaServiceError says which service and why.
   */
  async start(run: string, signal?: AbortSignal): Promise<{ network: string; variables: Record<string, string> }> {
    const { network, containers } = qaServiceNames(this.prefix, this.project, run, this.services);
    try {
      await this.docker.createInternalNetwork(network, QA_NETWORK_ROLE, this.project);
      for (const [service, declared] of Object.entries(this.services)) {
        signal?.throwIfAborted();
        const image = serviceImageOf(declared);
        const container = containers[service]!;
        const label = `The service ${service} (${declared.image}) for QA`;
        const created = await this.docker.run(
          [
            'run',
            '--detach',
            '--pull',
            'never',
            ...serviceRunArgs(declared, { name: container, labels: { [LABEL]: QA_SERVICE_ROLE, [PROJECT_LABEL]: this.project }, data: 'tmpfs' }),
            '--network',
            network,
            '--network-alias',
            service,
            image.reference,
          ],
          { timeoutMs: 120_000, signal },
        );
        if (created.code !== 0) {
          throw new QaServiceError(`${label} could not be started: ${lastLine(created.stderr) || `exit ${created.code}`}`);
        }
        const deadline = Date.now() + this.readyTimeoutMs;
        for (;;) {
          signal?.throwIfAborted();
          if ((await this.docker.run(['exec', container, ...image.ready], { timeoutMs: 30_000 })).code === 0) {
            break;
          }
          const running = (await this.docker.inspectContainer(container))?.running ?? false;
          if (!running || Date.now() >= deadline) {
            const oom = !running && (await this.docker.oomKilled(container));
            const logs = await this.docker.run(['logs', '--tail', '20', container], { timeoutMs: 30_000 });
            const said = lastLine(`${logs.stdout.toString('utf8')}\n${logs.stderr}`);
            const reason = oom ? 'it ran out of memory' : running ? `it was not ready after ${this.readyTimeoutMs / 1000} s` : `it stopped${said ? `: ${said}` : ''}`;
            throw new QaServiceError(`${label} did not start: ${reason}`);
          }
          await new Promise((resolve) => setTimeout(resolve, this.pollMs));
        }
      }
    } catch (error) {
      await this.remove(run).catch(() => {});
      throw error;
    }
    return {
      network,
      variables: serviceVariables(this.services, (service) => ({ host: service, port: serviceImageOf(this.services[service]!).port })),
    };
  }

  /** Removes the services and the network of one run; "no such container" is fine. */
  async remove(run: string): Promise<void> {
    const { network, containers } = qaServiceNames(this.prefix, this.project, run, this.services);
    for (const container of Object.values(containers)) {
      await this.docker.removeContainer(container);
    }
    await this.docker.removeNetwork(network).catch(() => {});
  }
}

/**
 * Removes every QA service and QA network a crash left behind, of any project, from Docker's
 * listing by role; only names with the app's prefix. Returns what it removed.
 */
export async function sweepQaServices(docker: Docker, prefix: string): Promise<string[]> {
  const lines = (text: string) => text.split(/\r?\n/).filter((name) => name.startsWith(`${prefix}-`));
  const containers = lines((await docker.checked(['container', 'ls', '--all', '--filter', `label=${LABEL}=${QA_SERVICE_ROLE}`, '--format', '{{.Names}}'], { timeoutMs: 30_000 })).stdout.toString('utf8'));
  for (const container of containers) {
    await docker.removeContainer(container);
  }
  const networks = lines((await docker.checked(['network', 'ls', '--filter', `label=${LABEL}=${QA_NETWORK_ROLE}`, '--format', '{{.Name}}'], { timeoutMs: 30_000 })).stdout.toString('utf8'));
  for (const network of networks) {
    await docker.removeNetwork(network).catch(() => {});
  }
  return [...containers, ...networks];
}
