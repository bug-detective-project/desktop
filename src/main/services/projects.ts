/**
 * The game projects the desktop app uses. content/projects.json (versioned, packaged) lists each
 * project's public repository; projects.local.json (development only, never packaged or committed)
 * may point a project at a local qa folder. publish:project keeps projects.json up to date.
 */
import { isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { runCommand } from './process.ts';
import { CachedContentSource } from './content/cache.ts';
import { GitHubContentSource } from './content/github.ts';
import { LocalContentSource } from './content/local.ts';
import type { ContentSource } from './content/source.ts';

const PROJECT_ID = /^[a-z][a-z0-9-]{0,39}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

const catalogSchema = z
  .object({
    projects: z
      .array(
        z.object({
          /** Must match project.id in the manifest of the project's qa branch. */
          id: z.string().regex(PROJECT_ID),
          /** "owner/name" of the project's public GitHub repository. */
          repository: z.string().regex(REPOSITORY),
          /** The project a new game starts with; exactly one. */
          starter: z.boolean(),
          /** The last published version; a downloaded manifest must not be older. */
          version: z.string().regex(/^\d+\.\d+\.\d+$/),
        }),
      )
      .min(1),
  })
  .superRefine((catalog, ctx) => {
    const ids = catalog.projects.map((project) => project.id);
    const repeated = ids.find((id, index) => ids.indexOf(id) !== index);
    if (repeated) {
      ctx.addIssue({ code: 'custom', message: `the project ${repeated} is listed twice` });
    }
    const starters = catalog.projects.filter((project) => project.starter).length;
    if (starters !== 1) {
      ctx.addIssue({ code: 'custom', message: `exactly one project must be the starter (found ${starters})` });
    }
  });

export type ProjectsCatalog = z.infer<typeof catalogSchema>;
export type CatalogProject = ProjectsCatalog['projects'][number];

export function parseProjectsCatalog(raw: unknown): ProjectsCatalog {
  const result = catalogSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid content/projects.json: ${result.error.issues[0]?.message ?? 'unknown error'}`);
  }
  return result.data;
}

/** The project a new game starts with. */
export function starterProject(catalog: ProjectsCatalog): CatalogProject {
  return catalog.projects.find((project) => project.starter)!;
}

/**
 * projects.local.json: { "<project id>": "<qa folder>" }. A listed project reads that folder in
 * development; a project that only this file names is added to the list in development (a local
 * sample project, for example), never in the installed app.
 */
export function parseLocalProjects(raw: unknown): Record<string, string> {
  const result = z.record(z.string().regex(PROJECT_ID, 'project ids are lowercase, like supportdesk'), z.string().min(1)).safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid projects.local.json: ${result.error.issues[0]?.message ?? 'unknown error'}`);
  }
  return result.data;
}

/** The catalog plus, in development, the projects only projects.local.json names (never the starter). */
export function withLocalProjects(catalog: ProjectsCatalog, localDirs: Record<string, string>, packaged: boolean): ProjectsCatalog {
  if (packaged) {
    return catalog;
  }
  const extra = Object.keys(localDirs)
    .filter((id) => !catalog.projects.some((project) => project.id === id))
    .map((id) => ({ id, repository: `local/${id}`, starter: false, version: '0.0.0' }));
  return { projects: [...catalog.projects, ...extra] };
}

export type ContentChoice =
  | { kind: 'github'; repository: string; project: string; minVersion: string }
  | { kind: 'local'; qaDir: string; project: string };

/**
 * Where a project's content comes from: its repository, unless development sets a local qa
 * folder for it (relative folders are relative to baseDir, the desktop folder). The installed
 * app always downloads.
 */
export function chooseContentSource(
  project: CatalogProject,
  options: { packaged: boolean; localDirs: Record<string, string>; baseDir: string },
): ContentChoice {
  const local = options.packaged ? undefined : options.localDirs[project.id];
  if (local) {
    return { kind: 'local', qaDir: isAbsolute(local) ? local : resolve(options.baseDir, local), project: project.id };
  }
  return { kind: 'github', repository: project.repository, project: project.id, minVersion: project.version };
}

/** projects.json after publishing a project: its new version, or a new entry (the starter only when it is the first). */
export function updateCatalog(catalog: { projects: CatalogProject[] }, published: { id: string; repository: string; version: string }): ProjectsCatalog {
  const listed = catalog.projects.some((project) => project.id === published.id);
  const projects = listed
    ? catalog.projects.map((project) =>
        project.id === published.id ? { ...project, repository: published.repository, version: published.version } : project,
      )
    : [...catalog.projects, { ...published, starter: catalog.projects.length === 0 }];
  return parseProjectsCatalog({ projects });
}

/** "owner/name" from a GitHub remote URL (SSH or HTTPS). */
export function repositoryFromRemote(url: string): string {
  const match = /^(?:git@github\.com:|https:\/\/github\.com\/)([^/\s]+\/[^/\s]+?)(?:\.git)?\/?$/.exec(url.trim());
  if (!match || !REPOSITORY.test(match[1])) {
    throw new Error(`The project's origin remote is not a GitHub repository: ${url.trim()}`);
  }
  return match[1];
}

/**
 * The content source of a project: a local qa folder in development when projects.local.json sets
 * one, otherwise its GitHub repository, cached in <userData>/projects/<id>/content/ so the project
 * plays offline after its first download.
 */
export function contentSourceFor(
  project: CatalogProject,
  options: { packaged: boolean; localDirs: Record<string, string>; baseDir: string; userData: string; baseUrl?: string },
  log: (line: string) => void,
): ContentSource {
  const choice = chooseContentSource(project, options);
  if (choice.kind === 'local') {
    return new LocalContentSource({ qaDir: choice.qaDir, runner: runCommand });
  }
  const remote = new GitHubContentSource({ repository: choice.repository, project: choice.project, minVersion: choice.minVersion, baseUrl: options.baseUrl });
  return new CachedContentSource(join(options.userData, 'projects', project.id, 'content'), remote, log);
}
