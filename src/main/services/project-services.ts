/**
 * The services a project declares (a database, a cache), as containers next to the workspace.
 *
 * Each service is one container on the project's internal network, reachable by the service's
 * name, with a named volume on every data path of its image: never an anonymous volume, never a
 * published port, never a restart policy. Everything carries the app's labels (roles `service`
 * and `service-data`, and the project), so removal starts from Docker's own listing.
 *
 * A service that fails does not throw: the game goes on and the Dashboard says which one and why.
 */
import { createHash } from 'node:crypto';
import { SERVICE_READY_TIMEOUT_MS, serviceImageOf, serviceRunArgs, serviceVariables } from '@bug-detective/catalog/contract';
import type { ProjectService, ProjectServices as Declared, ServiceImage } from '@bug-detective/catalog/contract';
import type { ServiceStatus } from '../../shared/api.ts';
import { LABEL, PROJECT_LABEL } from './docker.ts';
import type { Docker } from './docker.ts';

export type { ServiceState, ServiceStatus } from '../../shared/api.ts';

export const SERVICE_ROLE = 'service';
export const SERVICE_DATA_ROLE = 'service-data';
/** Changes when the declaration of a service does: the container is then recreated, its data kept. */
export const SERVICE_KEY_LABEL = 'bugdetective.service-key';

/** The container of a service and the named volume of each data path of its image. */
export function serviceNames(prefix: string, project: string, service: string, image: ServiceImage): { container: string; volumes: Record<string, string> } {
  return {
    container: `${prefix}-svc-${project}-${service}`,
    volumes: Object.fromEntries(image.dataPaths.map((path, index) => [path, `${prefix}-svcdata-${project}-${service}-${index}`])),
  };
}

/** A short hash of what the container is created from: the pinned image, the memory and the environment. */
export function declarationKey(service: ProjectService): string {
  const env = Object.entries(service.env ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const text = JSON.stringify([serviceImageOf(service).reference, service.memory ?? null, env]);
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export interface ProjectServicesOptions {
  docker: Docker;
  /** Prefix of every Docker resource name (tests use their own). */
  prefix: string;
  project: string;
  /** The project's internal network; it must exist. */
  network: string;
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

export class ProjectServices {
  private readonly docker: Docker;
  private readonly prefix: string;
  private readonly project: string;
  private readonly network: string;
  private readonly services: Declared;
  private readonly readyTimeoutMs: number;
  private readonly pollMs: number;

  constructor(options: ProjectServicesOptions) {
    this.docker = options.docker;
    this.prefix = options.prefix;
    this.project = options.project;
    this.network = options.network;
    this.services = options.services;
    this.readyTimeoutMs = options.readyTimeoutMs ?? SERVICE_READY_TIMEOUT_MS;
    this.pollMs = options.pollMs ?? 200;
  }

  private entries(): { name: string; declared: ProjectService; image: ServiceImage; container: string; volumes: Record<string, string> }[] {
    return Object.entries(this.services).map(([name, declared]) => {
      const image = serviceImageOf(declared);
      return { name, declared, image, ...serviceNames(this.prefix, this.project, name, image) };
    });
  }

  /** What the project's code reads: each service by its name on the internal network, on its image's port. */
  variables(): Record<string, string> {
    return serviceVariables(this.services, (name) => ({ host: name, port: serviceImageOf(this.services[name]!).port }));
  }

  private async isReady(container: string, image: ServiceImage): Promise<boolean> {
    return (await this.docker.run(['exec', container, ...image.ready], { timeoutMs: 30_000 })).code === 0;
  }

  /** Why a container that is not running stopped: killed for lack of memory, or the end of its log. */
  private async stopped(container: string): Promise<Pick<ServiceStatus, 'state' | 'reason'>> {
    if (await this.docker.oomKilled(container)) {
      return { state: 'oom' };
    }
    const logs = await this.docker.run(['logs', '--tail', '20', container], { timeoutMs: 30_000 });
    const reason = lastLine(`${logs.stdout.toString('utf8')}\n${logs.stderr}`);
    return { state: 'failed', ...(reason && { reason }) };
  }

  /**
   * Creates the volumes, creates or starts each container (recreating one whose declaration
   * changed) and waits until it accepts connections. Never throws for a service that fails: its
   * status says so, and the others still start.
   */
  async ensureRunning(): Promise<ServiceStatus[]> {
    const statuses: ServiceStatus[] = [];
    for (const entry of this.entries()) {
      statuses.push({ name: entry.name, image: entry.declared.image, ...(await this.ensureOne(entry)) });
    }
    return statuses;
  }

  private async ensureOne(entry: ReturnType<ProjectServices['entries']>[number]): Promise<Pick<ServiceStatus, 'state' | 'reason'>> {
    const { declared, image, container, volumes } = entry;
    const key = declarationKey(declared);
    for (const volume of Object.values(volumes)) {
      await this.docker.createVolume(volume, SERVICE_DATA_ROLE, this.project);
    }
    let info = await this.docker.inspectContainer(container);
    if (info && info.labels[SERVICE_KEY_LABEL] !== key) {
      // Another image, memory or environment: a new container on the same data.
      await this.docker.removeContainer(container);
      info = null;
    }
    if (info && !info.running) {
      const started = await this.docker.run(['container', 'start', container], { timeoutMs: 60_000 });
      if (started.code !== 0) {
        await this.docker.removeContainer(container);
        info = null;
      }
    }
    if (!info) {
      const created = await this.docker.run(
        [
          'run',
          '--detach',
          ...serviceRunArgs(declared, {
            name: container,
            labels: { [LABEL]: SERVICE_ROLE, [PROJECT_LABEL]: this.project, [SERVICE_KEY_LABEL]: key },
            data: volumes,
          }),
          '--network',
          this.network,
          '--network-alias',
          entry.name,
          image.reference,
        ],
        { timeoutMs: 120_000 },
      );
      if (created.code !== 0) {
        await this.docker.removeContainer(container);
        return { state: 'failed', reason: lastLine(created.stderr) || `docker run exited with ${created.code}` };
      }
    }
    const deadline = Date.now() + this.readyTimeoutMs;
    for (;;) {
      if (await this.isReady(container, image)) {
        return { state: 'ready' };
      }
      if (!(await this.docker.inspectContainer(container))?.running) {
        return this.stopped(container);
      }
      if (Date.now() >= deadline) {
        return { state: 'failed', reason: `not ready after ${this.readyTimeoutMs / 1000} s` };
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollMs));
    }
  }

  /** The state of each service as it is, creating and starting nothing. */
  async status(): Promise<ServiceStatus[]> {
    const statuses: ServiceStatus[] = [];
    for (const { name, declared, image, container } of this.entries()) {
      const info = await this.docker.inspectContainer(container);
      let status: Pick<ServiceStatus, 'state' | 'reason'>;
      if (!info) {
        status = { state: 'starting' };
      } else if (!info.running) {
        status = await this.stopped(container);
      } else {
        status = { state: (await this.isReady(container, image)) ? 'ready' : 'starting' };
      }
      statuses.push({ name, image: declared.image, ...status });
    }
    return statuses;
  }

  /** Stops the containers; the volumes (the data) stay. */
  async stop(signal?: AbortSignal): Promise<void> {
    const containers = this.entries().map((entry) => entry.container);
    if (containers.length > 0) {
      await this.docker.run(['container', 'stop', '--time', '5', ...containers], { timeoutMs: 30_000, signal });
    }
  }

  private async listed(kind: 'container' | 'volume', role: string): Promise<string[]> {
    const args =
      kind === 'container'
        ? ['container', 'ls', '--all', '--filter', `label=${LABEL}=${role}`, '--filter', `label=${PROJECT_LABEL}=${this.project}`, '--format', '{{.Names}}']
        : ['volume', 'ls', '--filter', `label=${LABEL}=${role}`, '--filter', `label=${PROJECT_LABEL}=${this.project}`, '--format', '{{.Name}}'];
    const result = await this.docker.checked(args, { timeoutMs: 30_000 });
    return result.stdout.toString('utf8').split(/\r?\n/).filter(Boolean);
  }

  /**
   * Removes every service container and data volume of the project, from Docker's listing by
   * label (so one left by an older declaration goes too), and lists again: what is still there is
   * an error that names it.
   */
  async removeAll(): Promise<void> {
    for (const container of await this.listed('container', SERVICE_ROLE)) {
      await this.docker.removeContainer(container);
    }
    for (const volume of await this.listed('volume', SERVICE_DATA_ROLE)) {
      await this.docker.removeVolume(volume);
    }
    const left = [...(await this.listed('container', SERVICE_ROLE)), ...(await this.listed('volume', SERVICE_DATA_ROLE))];
    if (left.length > 0) {
      throw new Error(`Could not remove the project's services: ${left.join(', ')}`);
    }
  }
}
