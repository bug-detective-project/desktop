/**
 * The content source of a game project from its entry in the projects catalog (services/catalog.ts):
 * a local qa folder when the entry has one (development and tests), otherwise its GitHub repository
 * on its qa ref, cached in <userData>/projects/<id>/content/ so the project plays offline after its
 * first download.
 */
import { join } from 'node:path';
import type { ResolvedProject } from './catalog.ts';
import { runCommand } from './process.ts';
import { CachedContentSource } from './content/cache.ts';
import { GitHubContentSource } from './content/github.ts';
import { LocalContentSource } from './content/local.ts';
import type { ContentSource } from './content/source.ts';

export function contentSourceFor(
  project: ResolvedProject,
  options: { userData: string; minVersion: string | null; baseUrl?: string; fetch?: typeof fetch },
  log: (line: string) => void,
): ContentSource {
  if (project.qaDir !== undefined) {
    return new LocalContentSource({ qaDir: project.qaDir, runner: runCommand });
  }
  const remote = new GitHubContentSource({
    repository: project.repository,
    project: project.id,
    qaRef: project.qaRef,
    fetch: options.fetch,
    minVersion: options.minVersion ?? undefined,
    baseUrl: options.baseUrl,
  });
  return new CachedContentSource(join(options.userData, 'projects', project.id, 'content'), remote, log);
}
