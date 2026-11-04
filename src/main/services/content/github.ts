/**
 * GitHub source: the qa branch archive of a project's public repository (manifest.json and the
 * ticket packages) and the archive of the ticket's commit. No login or token: GitHub is a download
 * source only.
 */
import { ContentVerificationError, IncompletePublicationError, compareVersions, countsOf, entryById, packageOf, parseManifest, projectContentOf, readZip, verifyCode, verifyPackage } from '@bug-detective/catalog/contract';
import type { ArchiveFile, TicketEntry } from '@bug-detective/catalog/contract';
import { verifyTicket } from './source.ts';
import type { ContentSource, FetchedTicket, ProjectContent } from './source.ts';

export interface GitHubSourceOptions {
  /** "owner/name" of the project's public repository (main, qa and the ticket branches). */
  repository: string;
  /** The project id the manifest must declare (its id in the projects catalog). */
  project: string;
  /** The branch or tag the content comes from (default qa). */
  qaRef?: string;
  /** The oldest manifest version to accept: an older one is a publication not pushed yet, or a stale cache. */
  minVersion?: string;
  /** https://github.com, or a local mock server in tests. */
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  maxBytes?: number;
  /** Tests: the wait for Retry-After and between attempts, without really waiting. */
  sleep?: (ms: number) => Promise<void>;
}

export class DownloadError extends Error {
  readonly status: number | undefined;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

/** Every attempt failed on the network (DNS, a refused or dropped connection, a timeout): no internet, most likely. */
export class NoConnectionError extends Error {}

/** GitHub answered 429 or 403 with Retry-After beyond what a download waits (shared networks hit the anonymous limit). */
export class RateLimitedError extends Error {
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number) {
    super(message);
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** The project's qa ref is not there: the repository or the branch is gone, private, or renamed. */
export class ProjectUnavailableError extends Error {
  readonly repository: string;

  constructor(repository: string, qaRef: string) {
    super(`${repository} has no ${qaRef} branch or tag`);
    this.repository = repository;
  }
}

/** The longest a download waits, in total, for GitHub's Retry-After. */
export const MAX_RETRY_AFTER_SECONDS = 60;

/** The seconds of a Retry-After header (a delay, or an HTTP date), or null when there is none. */
export function retryAfterSeconds(value: string | null, now = Date.now()): number | null {
  if (value === null || value.trim() === '') return null;
  if (/^\d+$/.test(value.trim())) return Number(value.trim());
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - now) / 1000));
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
  private readonly qaRef: string;
  private readonly minVersion: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly retries: number;
  private readonly maxBytes: number;
  private readonly sleep: (ms: number) => Promise<void>;

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
    this.qaRef = options.qaRef ?? 'qa';
    this.minVersion = options.minVersion;
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.retries = options.retries ?? 3;
    this.maxBytes = options.maxBytes ?? 100 * 1024 * 1024;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  describe(): string {
    return `${this.base}/${this.repository} (${this.qaRef})`;
  }

  branchArchiveUrl(branch: string): string {
    return `${this.base}/${this.repository}/archive/refs/heads/${encodeURIComponent(branch)}.zip`;
  }

  tagArchiveUrl(tag: string): string {
    return `${this.base}/${this.repository}/archive/refs/tags/${encodeURIComponent(tag)}.zip`;
  }

  /** The archive of a qa ref: a branch of that name, or else a tag; neither means the project (or that publication) is gone. */
  private async qaArchive(signal?: AbortSignal, ref = this.qaRef): Promise<Uint8Array> {
    try {
      return await this.download(this.branchArchiveUrl(ref), signal);
    } catch (error) {
      if (error instanceof DownloadError && error.status === 404) {
        try {
          return await this.download(this.tagArchiveUrl(ref), signal);
        } catch (tagError) {
          if (tagError instanceof DownloadError && tagError.status === 404) {
            throw new ProjectUnavailableError(this.repository, ref);
          }
          throw tagError;
        }
      }
      throw error;
    }
  }

  /** The tag a publication gets when its pull request into qa is merged. */
  static publicationTag(version: string): string {
    return `qa-v${version}`;
  }

  commitArchiveUrl(commit: string): string {
    return `${this.base}/${this.repository}/archive/${commit}.zip`;
  }

  /**
   * Downloads into memory with a size limit and a timeout, retrying network errors and 5xx; a
   * 429 (or a 403 with Retry-After: GitHub's anonymous limit) waits what the header says, up to
   * MAX_RETRY_AFTER_SECONDS in all, then gives up as RateLimitedError. Network errors on every
   * attempt end as NoConnectionError.
   */
  async download(url: string, signal?: AbortSignal): Promise<Uint8Array> {
    let lastError: unknown;
    let waitedSeconds = 0;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      signal?.throwIfAborted();
      if (attempt > 0) {
        await this.sleep(250 * 2 ** attempt);
      }
      try {
        const timeout = AbortSignal.timeout(this.timeoutMs);
        const response = await this.fetchImpl(url, {
          redirect: 'follow',
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: { 'User-Agent': 'BugDetective' },
        });
        const retryAfter = retryAfterSeconds(response.headers.get('retry-after'));
        if (response.status === 429 || (response.status === 403 && retryAfter !== null)) {
          const seconds = retryAfter ?? 5;
          if (waitedSeconds + seconds > MAX_RETRY_AFTER_SECONDS) {
            throw new RateLimitedError(`${url}: HTTP ${response.status}, retry after ${seconds} s`, seconds);
          }
          waitedSeconds += seconds;
          await this.sleep(seconds * 1000);
          attempt -= 1; // A wait GitHub asked for is not one of the retries.
          continue;
        }
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
        if (error instanceof DownloadError || error instanceof RateLimitedError || signal?.aborted) {
          throw error;
        }
        lastError = error;
      }
    }
    if (lastError instanceof DownloadError) {
      throw new DownloadError(`Download failed: ${url} (${lastError.message})`, lastError.status);
    }
    throw new NoConnectionError(`Download failed: ${url} (${lastError instanceof Error ? lastError.message : String(lastError)})`);
  }

  /** The qa branch: the manifest and every ticket package, verified, plus the project files. */
  async fetchQa(signal?: AbortSignal): Promise<ProjectContent> {
    return this.fetchQaRef(this.qaRef, true, signal);
  }

  /** A given publication (its qa-v<version> tag), verified like the qa branch; the version floor does not apply to it. */
  async publication(version: string, signal?: AbortSignal): Promise<ProjectContent> {
    const content = await this.fetchQaRef(GitHubContentSource.publicationTag(version), false, signal);
    if (content.manifest.version !== version) {
      throw new ContentVerificationError(`${this.repository}: ${GitHubContentSource.publicationTag(version)} publishes ${content.manifest.version}, not ${version}`);
    }
    return content;
  }

  private async fetchQaRef(ref: string, applyFloor: boolean, signal?: AbortSignal): Promise<ProjectContent> {
    const qaFiles = readZip(await this.qaArchive(signal, ref), { stripTopDirectory: true });
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
    if (applyFloor && this.minVersion && compareVersions(manifest.version, this.minVersion) < 0) {
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

  codeOf(entry: TicketEntry, signal?: AbortSignal): Promise<ArchiveFile[]> {
    return this.fetchCode(entry, signal);
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
