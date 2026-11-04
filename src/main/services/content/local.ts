/**
 * Development source: a project's qa folder (a worktree of its qa branch) and the ticket branches
 * of the same repository. The manifest is always built in memory from the current content, with
 * the same code as publish:project, so development never uses a stale manifest.json.
 */
import type { CommandRunner } from '../process.ts';
import { gitArchive } from './git.ts';
import { buildManifest, readQaFiles, readTicketPackage } from './local-manifest.ts';
import { entryById, countsOf, verifyCode } from '@bug-detective/catalog/contract';
import type { ArchiveFile, TicketEntry } from '@bug-detective/catalog/contract';
import { verifyTicket } from './source.ts';
import type { ContentSource, FetchedTicket, ProjectContent } from './source.ts';

export { gitArchive } from './git.ts';

export interface LocalSourceOptions {
  /** The project's qa folder, for example ../supportdesk-qa. */
  qaDir: string;
  runner: CommandRunner;
  git?: string;
}

export class LocalContentSource implements ContentSource {
  readonly kind = 'local';
  private readonly options: LocalSourceOptions;

  constructor(options: LocalSourceOptions) {
    this.options = options;
  }

  describe(): string {
    return this.options.qaDir;
  }

  async prepare(): Promise<ProjectContent> {
    const { qaDir, runner, git = 'git' } = this.options;
    return {
      manifest: await buildManifest({ qaDir, version: '0.0.0', runner, git }),
      qaFiles: await readQaFiles(qaDir, runner, git),
    };
  }

  /** A local folder is always available. */
  current(): Promise<ProjectContent | null> {
    return this.prepare();
  }

  /** A local folder has one version, whatever a save calls it: the content as it is now. */
  publication(): Promise<ProjectContent> {
    return this.prepare();
  }

  async codeOf(entry: TicketEntry): Promise<ArchiveFile[]> {
    const { qaDir, runner, git = 'git' } = this.options;
    return verifyCode(entry, await gitArchive(runner, git, qaDir, entry.commit));
  }

  async fetchTicket(id: string): Promise<FetchedTicket> {
    const { qaDir, runner, git = 'git' } = this.options;
    const manifest = await buildManifest({ qaDir, version: '0.0.0', runner, git });
    const entry = entryById(manifest, id);
    return verifyTicket({
      counts: countsOf(manifest),
      manifestVersion: manifest.version,
      entry,
      packageFiles: await readTicketPackage(qaDir, entry.id, runner, git),
      codeFiles: await gitArchive(runner, git, qaDir, entry.commit),
    });
  }
}
