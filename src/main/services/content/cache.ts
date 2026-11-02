/**
 * The installed app's content of a project, kept in <userData>/projects/<id>/content/ so the
 * project plays offline after its first download:
 *   qa.zip              the qa branch (manifest, ticket packages, QA tool, story, review.json)
 *   code/<commit>.zip   the code of every ticket in that manifest
 *   cache.json          the cached version and when it was last checked
 * A download only replaces qa.zip after every ticket's code is stored and verified, so a failed
 * update leaves the previous content in place.
 */
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { readZip, writeZip } from './archive.ts';
import type { ArchiveFile } from './archive.ts';
import { DownloadError } from './github.ts';
import type { GitHubContentSource } from './github.ts';
import { ContentVerificationError, parseManifest } from './manifest.ts';
import type { TicketEntry } from './manifest.ts';
import { entryById, countsOf, packageOf, verifyCode, verifyTicket } from './source.ts';
import type { ContentSource, FetchedTicket, ProjectContent } from './source.ts';
import { writeFileAtomic } from './store.ts';

/** Nothing is cached yet and the download failed: the first setup needs the internet. */
export class FirstDownloadError extends Error {}

export class CachedContentSource implements ContentSource {
  readonly kind = 'github';
  private readonly root: string;
  private readonly remote: GitHubContentSource;
  private readonly log: (line: string) => void;

  constructor(root: string, remote: GitHubContentSource, log: (line: string) => void = () => {}) {
    this.root = root;
    this.remote = remote;
    this.log = log;
  }

  describe(): string {
    return `${this.remote.describe()}, cached in ${this.root}`;
  }

  async forget(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }

  private codePath(commit: string): string {
    return join(this.root, 'code', `${commit}.zip`);
  }

  async current(): Promise<ProjectContent | null> {
    const file = join(this.root, 'qa.zip');
    if (!existsSync(file)) {
      return null;
    }
    const qaFiles = readZip(await readFile(file));
    const manifestFile = qaFiles.find((item) => item.path === 'manifest.json');
    if (!manifestFile) {
      throw new ContentVerificationError(`${file} has no manifest.json`);
    }
    return { manifest: parseManifest(JSON.parse(Buffer.from(manifestFile.data).toString('utf8'))), qaFiles };
  }

  /** Downloads the qa branch and the code of every ticket, then replaces the cached content. */
  async prepare(signal?: AbortSignal): Promise<ProjectContent> {
    try {
      const content = await this.remote.fetchQa(signal);
      for (const entry of content.manifest.entries) {
        if (!existsSync(this.codePath(entry.commit))) {
          await writeFileAtomic(this.codePath(entry.commit), writeZip(await this.remote.fetchCode(entry, signal)));
        }
      }
      await writeFileAtomic(join(this.root, 'qa.zip'), writeZip(content.qaFiles));
      await writeFileAtomic(
        join(this.root, 'cache.json'),
        `${JSON.stringify({ version: content.manifest.version, checkedAt: new Date().toISOString() }, null, 2)}\n`,
      );
      return content;
    } catch (error) {
      if (error instanceof DownloadError && !existsSync(join(this.root, 'qa.zip'))) {
        throw new FirstDownloadError(`Connect to the internet to download the project for the first time (${error.message})`);
      }
      throw error;
    }
  }

  private async code(entry: TicketEntry, signal?: AbortSignal): Promise<ArchiveFile[]> {
    const path = this.codePath(entry.commit);
    if (existsSync(path)) {
      return verifyCode(entry, readZip(await readFile(path)));
    }
    const code = await this.remote.fetchCode(entry, signal);
    await writeFileAtomic(path, writeZip(code));
    return code;
  }

  /**
   * Looks for a newer publication first; when that fails (offline, or a broken publication), the
   * cached content is used and the reason is logged. Only an empty cache needs the network.
   */
  async fetchTicket(id: string, signal?: AbortSignal): Promise<FetchedTicket> {
    let content: ProjectContent | null;
    try {
      content = await this.prepare(signal);
    } catch (error) {
      content = await this.current();
      if (!content) {
        throw error;
      }
      this.log(`» Using the downloaded ${content.manifest.version}: ${(error as Error).message}`);
    }
    const entry = entryById(content.manifest, id);
    return verifyTicket({
      counts: countsOf(content.manifest),
      manifestVersion: content.manifest.version,
      entry,
      packageFiles: packageOf(entry, content.qaFiles),
      codeFiles: await this.code(entry, signal),
    });
  }
}
