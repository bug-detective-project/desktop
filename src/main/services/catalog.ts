/**
 * The projects catalog: projects.json on the main branch of bug-detective-project/catalog, which
 * says where each game project lives. The app downloads it at run time (on start, when the player
 * takes a ticket, and when the Projects screen opens), keeps the last valid copy in
 * <userData>/catalog.json, and falls back to the copy bundled at build time when it never
 * downloaded one. In development, desktop/catalog.local.json may point at another branch of a
 * catalog repository of the organization, or at a file, and override a project's qa ref or folder;
 * the tests use BUGDETECTIVE_CATALOG_FILE.
 */
import { readFile, rm } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { z } from 'zod';
import { PROJECT_OWNER, parseCatalog } from '@bug-detective/catalog/contract';
import type { Catalog, CatalogProject } from '@bug-detective/catalog/contract';
import { writeFileAtomic } from './content/store.ts';
import type { LocalCatalog } from '../../shared/api.ts';

export const OFFICIAL_CATALOG_URL = 'https://raw.githubusercontent.com/bug-detective-project/catalog/main/projects.json';
const FETCH_TIMEOUT_MS = 30_000;

/** A repository of the organization, like the contract's rule for project repositories. */
const REPOSITORY = new RegExp(`^${PROJECT_OWNER}/[A-Za-z0-9_.-]{1,100}$`);
const PROJECT_ID = /^[a-z][a-z0-9-]{0,39}$/;

export type CatalogSourceChoice = { kind: 'official' } | { kind: 'github'; repository: string; branch: string } | { kind: 'file'; path: string };

const overrideSchema = z.union([z.object({ qaDir: z.string().min(1) }).strict(), z.object({ qaRef: z.string().min(1).max(100) }).strict()]);

export const localCatalogSchema = z
  .object({
    catalog: z
      .union([
        z.object({ github: z.string().regex(REPOSITORY, `use ${PROJECT_OWNER}/<name>`), branch: z.string().min(1).max(100).default('main') }).strict(),
        z.object({ file: z.string().min(1) }).strict(),
      ])
      .optional(),
    projects: z.record(z.string().regex(PROJECT_ID, 'project ids are lowercase, like supportdesk'), overrideSchema).optional(),
  })
  .strict();

export type { LocalCatalog } from '../../shared/api.ts';
export type ProjectOverride = z.infer<typeof overrideSchema>;

/** desktop/catalog.local.json (development only). */
export function parseLocalCatalog(raw: unknown): LocalCatalog {
  const result = localCatalogSchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`Invalid catalog.local.json: ${issue?.path.join('.') || 'file'}: ${issue?.message ?? 'unknown error'}`);
  }
  return result.data;
}

/** desktop/catalog.local.json as the Development settings read it: a missing or invalid file reads as the defaults (the error says why). */
export async function readLocalCatalogFile(path: string): Promise<{ settings: LocalCatalog; error: string | null }> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    return { settings: {}, error: null };
  }
  try {
    return { settings: parseLocalCatalog(JSON.parse(text)), error: null };
  } catch (error) {
    const message = (error as Error).message;
    return { settings: {}, error: message.startsWith('Invalid catalog.local.json') ? message : `Invalid catalog.local.json: ${message}` };
  }
}

/** Writes the Development settings; the defaults (official catalog, no override) delete the file. Invalid settings throw and keep the file. */
export async function writeLocalCatalogFile(path: string, settings: LocalCatalog): Promise<void> {
  const parsed = parseLocalCatalog(settings);
  if (!parsed.catalog && Object.keys(parsed.projects ?? {}).length === 0) {
    await rm(path, { force: true });
    return;
  }
  await writeFileAtomic(path, `${JSON.stringify(parsed, null, 2)}\n`);
}

/** Where the catalog comes from. The installed app always reads the official one. */
export function chooseCatalogSource(options: {
  packaged: boolean;
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  localCatalog: LocalCatalog | null;
  baseDir: string;
}): CatalogSourceChoice {
  if (options.packaged) {
    return { kind: 'official' };
  }
  const testFile = options.env.BUGDETECTIVE_CATALOG_FILE;
  if (testFile) {
    return { kind: 'file', path: resolve(options.baseDir, testFile) };
  }
  const source = options.localCatalog?.catalog;
  if (source && 'github' in source) {
    return { kind: 'github', repository: source.github, branch: source.branch ?? 'main' };
  }
  if (source) {
    return { kind: 'file', path: resolve(options.baseDir, source.file) };
  }
  return { kind: 'official' };
}

export function describeSource(choice: CatalogSourceChoice): string {
  switch (choice.kind) {
    case 'official':
      return 'official';
    case 'github':
      return `github ${choice.repository}@${choice.branch}`;
    case 'file':
      return `file ${choice.path}`;
  }
}

/** A project of the catalog as the app uses it: with a local folder when one is set, and whether its source is the official one. */
export type ResolvedProject = CatalogProject & { qaDir?: string; official: boolean };

/** A file catalog (development and tests): an entry may name a local qa folder instead of a repository (the placeholder repository satisfies the contract; the folder wins). */
function parseFileCatalog(raw: unknown): Catalog & { folders: Record<string, string> } {
  const projects = (raw as { projects?: unknown })?.projects;
  const folders: Record<string, string> = {};
  const entries = Array.isArray(projects)
    ? projects.map((entry: Record<string, unknown>) => {
        if (entry && typeof entry.qaDir === 'string' && entry.repository === undefined) {
          folders[String(entry.id)] = entry.qaDir;
          const { qaDir: _local, ...rest } = entry;
          return { ...rest, repository: `${PROJECT_OWNER}/${String(entry.id)}` };
        }
        return entry;
      })
    : projects;
  return { ...parseCatalog({ ...(raw as object), projects: entries }), folders };
}

interface CacheFile {
  source: string;
  fetchedAt: string;
  catalog: unknown;
}

export interface CatalogServiceOptions {
  choice: CatalogSourceChoice;
  /** catalog.local.json's per-project overrides. */
  overrides: Record<string, ProjectOverride>;
  /** Relative folders are relative to it (the desktop folder). */
  baseDir: string;
  cacheFile: string;
  fallbackFile: string;
  fetchText?: (url: string) => Promise<string>;
  log: (line: string) => void;
}

async function fetchTextWithTimeout(url: string): Promise<string> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`);
  }
  return response.text();
}

export class CatalogService {
  private options: CatalogServiceOptions;
  /** The last current() fell back to the copy bundled at build time. */
  private fallback = false;
  private readonly fetchText: (url: string) => Promise<string>;

  constructor(options: CatalogServiceOptions) {
    this.options = options;
    this.fetchText = options.fetchText ?? fetchTextWithTimeout;
  }

  describe(): string {
    return describeSource(this.options.choice);
  }

  /** Development settings applied without a restart: another source and other overrides. */
  reconfigure(choice: CatalogSourceChoice, overrides: Record<string, ProjectOverride>): void {
    this.options = { ...this.options, choice, overrides };
  }

  /** Downloads (or reads) the catalog and replaces the cache when it is valid; otherwise keeps the cache and logs why. */
  async refresh(): Promise<boolean> {
    const { choice } = this.options;
    try {
      const text = choice.kind === 'file' ? await readFile(choice.path, 'utf8') : await this.fetchText(this.url());
      const raw: unknown = JSON.parse(text);
      // Validate before replacing anything: an invalid catalog never replaces a valid one.
      if (choice.kind === 'file') {
        parseFileCatalog(raw);
      } else {
        parseCatalog(raw);
      }
      const cache: CacheFile = { source: this.describe(), fetchedAt: new Date().toISOString(), catalog: raw };
      await writeFileAtomic(this.options.cacheFile, `${JSON.stringify(cache, null, 2)}\n`);
      return true;
    } catch (error) {
      this.options.log(`» Projects catalog (${this.describe()}) not updated: ${(error as Error).message}`);
      return false;
    }
  }

  /**
   * The catalog in use: the cache of this source, otherwise the bundled fallback. A file catalog
   * is read again first: it is local, and on the first start nothing has refreshed it yet.
   */
  async current(): Promise<ResolvedProject[]> {
    if (this.options.choice.kind === 'file') {
      await this.refresh();
    }
    const cached = await readFile(this.options.cacheFile, 'utf8').then(
      (text) => JSON.parse(text) as CacheFile,
      () => null,
    );
    this.fallback = false;
    if (cached?.source === this.describe()) {
      try {
        return this.resolve(cached.catalog);
      } catch (error) {
        this.options.log(`» Cached projects catalog ignored: ${(error as Error).message}`);
      }
    }
    this.fallback = true;
    return this.resolve(JSON.parse(await readFile(this.options.fallbackFile, 'utf8')), true);
  }

  /** Whether the catalog in use is the bundled copy: the chosen source was never downloaded (or read). */
  usingFallback(): boolean {
    return this.fallback;
  }

  private url(): string {
    const { choice } = this.options;
    return choice.kind === 'github' ? `https://raw.githubusercontent.com/${choice.repository}/${choice.branch}/projects.json` : OFFICIAL_CATALOG_URL;
  }

  private resolve(raw: unknown, fallback = false): ResolvedProject[] {
    const { choice, overrides, baseDir } = this.options;
    const file = choice.kind === 'file' && !fallback;
    const catalog = file ? parseFileCatalog(raw) : { ...parseCatalog(raw), folders: {} as Record<string, string> };
    const sourceOfficial = choice.kind === 'official' || fallback;
    const folderOf = (path: string) => (isAbsolute(path) ? path : resolve(baseDir, path));
    return catalog.projects.map((project): ResolvedProject => {
      const override = overrides[project.id];
      const folder = override && 'qaDir' in override ? override.qaDir : catalog.folders[project.id];
      return {
        ...project,
        ...(override && 'qaRef' in override && { qaRef: override.qaRef }),
        ...(folder !== undefined && { qaDir: folderOf(folder) }),
        official: sourceOfficial && override === undefined && folder === undefined,
      };
    });
  }
}
