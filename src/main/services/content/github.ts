/**
 * GitHub source: the qa branch archive of a project's public repository (manifest.json and the
 * ticket packages) and the archive of the ticket's commit. No login or token: GitHub is a download
 * source only.
 */
import { readZip } from './archive.ts';
import type { ArchiveFile } from './archive.ts';
import { ContentVerificationError, compareVersions, parseManifest } from './manifest.ts';
import { projectContentOf } from './project-files.ts';
import { IncompletePublicationError, entryById, countsOf, packageOf, verifyCode, verifyPackage, verifyTicket } from './source.ts';
import type { ContentSource, FetchedTicket, ProjectContent } from './source.ts';
import type { TicketEntry } from './manifest.ts';

export interface GitHubSourceOptions {
  /** "owner/name" of the project's public repository (main, qa and the ticket branches). */
  repository: string;
  /** The project id the manifest must declare (its id in content/projects.json). */
  project: string;
  /** The version content/projects.json records: an older manifest is a publication not pushed yet, or a stale cache. */
  minVersion?: string;
  /** https://github.com, or a local mock server in tests. */
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  maxBytes?: number;
}

export class DownloadError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

const REPOSITORY = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const PROJECT = /^[a-z][a-z0-9-]{0,39}$/;

/** Only https, except loopback http for tests and local mirrors. */
export function validateBaseUrl(raw: string): URL {
  const url = new URL(raw);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`Content URL must use https: ${raw}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`Content URL must not contain credentials, a query or a fragment: ${raw}`);
  }
  return url;
}

export class GitHubContentSource implements ContentSource {
  readonly kind = 'github';
  private readonly base: string;
  private readonly repository: string;
  private readonly project: string;
  private readonly minVersion: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly maxBytes: number;

  constructor(options: GitHubSourceOptions) {
    if (!REPOSITORY.test(options.repository) || options.repository.split('/').some((part) => /^\.+$/.test(part))) {
      throw new Error(`Invalid repository: ${options.repository}`);
    }
    if (!PROJECT.test(options.project)) {
      throw new Error(`Invalid project id: ${options.project}`);
    }
    this.base = validateBaseUrl(options.baseUrl ?? 'https://github.com').href.replace(/\/$/, '');
    this.repository = options.repository;
    this.project = options.project;
    this.minVersion = options.minVersion;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.retries = options.retries ?? 3;
    this.maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
  }

  describe(): string {
    return `${this.base}/${this.repository} (qa)`;
  }

  branchArchiveUrl(branch: string): string {
    return `${this.base}/${this.repository}/archive/refs/heads/${encodeURIComponent(branch)}.zip`;
  }

  commitArchiveUrl(commit: string): string {
    return `${this.base}/${this.repository}/archive/${commit}.zip`;
  }

  /** Downloads into memory with a size limit and a timeout, retrying network errors and 5xx. */
  async download(url: string, signal?: AbortSignal): Promise<Uint8Array> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      signal?.throwIfAborted();
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
      }
      try {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const response = await this.fetchImpl(url, {
          redirect: 'follow',
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: { 'User-Agent': 'BugDetective' },
        });
        if (response.status >= 500) {
          lastError = new DownloadError(`${url}: HTTP ${response.status}`, response.status);
          continue;
        }
        if (!response.ok || !response.body) {
          throw new DownloadError(`${url}: HTTP ${response.status}`, response.status);
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        for await (const chunk of response.body) {
          size += chunk.length;
          if (size > this.maxBytes) {
            throw new DownloadError(`${url}: larger than ${this.maxBytes} bytes`);
          }
          chunks.push(chunk);
        }
        return new Uint8Array(Buffer.concat(chunks));
      } catch (error) {
        if (error instanceof DownloadError || signal?.aborted) {
          throw error;
        }
        lastError = error;
      }
    }
    throw new DownloadError(`Download failed: ${url} (${lastError instanceof Error ? lastError.message : String(lastError)})`);
  }

  /** The qa branch: the manifest and every ticket package, verified, plus the project files. */
  async fetchQa(signal?: AbortSignal): Promise<ProjectContent> {
    const qaFiles = readZip(await this.download(this.branchArchiveUrl('qa'), signal), { stripTopDirectory: true });
    const manifestFile = qaFiles.find((file) => file.path === 'manifest.json');
    if (!manifestFile) {
      throw new ContentVerificationError(`${this.repository}: the qa branch has no manifest.json`);
    }
    let json: unknown;
    try {
      json = JSON.parse(Buffer.from(manifestFile.data).toString('utf8'));
    } catch {
      throw new ContentVerificationError('The project manifest is not valid JSON');
    }
    const manifest = parseManifest(json, this.project);
    if (this.minVersion && compareVersions(manifest.version, this.minVersion) < 0) {
      throw new IncompletePublicationError(`${this.repository} publishes ${manifest.version}, older than ${this.minVersion}`);
    }
    for (const entry of manifest.entries) {
      verifyPackage(entry, packageOf(entry, qaFiles));
    }
    try {
      projectContentOf(qaFiles);
    } catch (error) {
      throw new ContentVerificationError((error as Error).message);
    }
    return { manifest, qaFiles };
  }

  /** The code of a ticket, by its commit, verified against its manifest entry. */
  async fetchCode(entry: TicketEntry, signal?: AbortSignal): Promise<ArchiveFile[]> {
    let code: Uint8Array;
    try {
      code = await this.download(this.commitArchiveUrl(entry.commit), signal);
    } catch (error) {
      if (error instanceof DownloadError && error.status === 404) {
        throw new IncompletePublicationError(`${this.repository} has no commit ${entry.commit} for ticket ${entry.id}`);
      }
      throw error;
    }
    return verifyCode(entry, readZip(code, { stripTopDirectory: true }));
  }

  async prepare(signal?: AbortSignal): Promise<ProjectContent> {
    return this.fetchQa(signal);
  }

  async current(): Promise<ProjectContent | null> {
    return null;
  }

  async fetchTicket(id: string, signal?: AbortSignal): Promise<FetchedTicket> {
    const { manifest, qaFiles } = await this.fetchQa(signal);
    const entry = entryById(manifest, id);
    return verifyTicket({
      counts: countsOf(manifest),
      manifestVersion: manifest.version,
      entry,
      packageFiles: packageOf(entry, qaFiles),
      codeFiles: await this.fetchCode(entry, signal),
    });
  }
}
