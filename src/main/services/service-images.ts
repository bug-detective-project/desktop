/**
 * The images of the services a project declares. They come from a registry, pinned by digest, so
 * they cannot carry the app's label: the app records in a file of its own which ones it pulled,
 * and removes only those. An image the computer already had is the player's and stays.
 *
 * The record lives beside the game state, not in it: it describes this computer's Docker, so it
 * must survive a new game and a restored save.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { serviceImageOf } from '@bug-detective/catalog/contract';
import type { ProjectServices } from '@bug-detective/catalog/contract';
import type { Docker } from './docker.ts';

/** The pinned references of a project's services, each once. */
export function serviceImageReferences(services: ProjectServices): string[] {
  return [...new Set(Object.values(services).map((service) => serviceImageOf(service).reference))];
}

export class ServiceImages {
  private readonly docker: Docker;
  private readonly file: string;

  constructor(options: { docker: Docker; file: string }) {
    this.docker = options.docker;
    this.file = options.file;
  }

  /** The references the app pulled; a missing or broken record is an empty one. */
  async pulled(): Promise<string[]> {
    try {
      const json = JSON.parse(await readFile(this.file, 'utf8')) as { pulled?: unknown };
      return Array.isArray(json.pulled) ? json.pulled.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  private async record(pulled: readonly string[]): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify({ pulled: [...new Set(pulled)] }, null, 2)}\n`);
  }

  /** The references that are not on this computer yet. */
  async missing(services: ProjectServices): Promise<string[]> {
    const missing: string[] = [];
    for (const reference of serviceImageReferences(services)) {
      if (!(await this.docker.imageExists(reference))) {
        missing.push(reference);
      }
    }
    return missing;
  }

  /** Pulls what is missing (needs internet) and records each image only once its pull succeeded. */
  async ensure(services: ProjectServices, onLine: (line: string) => void): Promise<void> {
    for (const reference of await this.missing(services)) {
      onLine(`» docker pull ${reference}`);
      await this.docker.checked(['pull', reference], { timeoutMs: 900_000, onLine });
      await this.record([...(await this.pulled()), reference]);
    }
  }

  /**
   * Removes the images the app pulled, except those in `keep`. Returns the ones Docker refused to
   * remove; they stay on record for the next attempt.
   */
  async removePulled(keep: readonly string[]): Promise<string[]> {
    const pulled = await this.pulled();
    const failed: string[] = [];
    const kept: string[] = [];
    for (const reference of pulled) {
      if (keep.includes(reference)) {
        kept.push(reference);
      } else if (await this.docker.imageExists(reference)) {
        await this.docker.removeImage(reference).catch(() => failed.push(reference));
      }
    }
    if (pulled.length > 0 || failed.length > 0) {
      await this.record([...kept, ...failed]);
    }
    return failed;
  }
}
