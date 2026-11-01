/** Git helpers of the content tools and the local source: archives, ticket branch refs, line endings. */
import { runChecked } from '../process.ts';
import type { CommandRunner } from '../process.ts';
import { readTar } from './archive.ts';
import type { ArchiveFile } from './archive.ts';

/** `git archive` of a ref, with line-ending conversion disabled so files keep LF on Windows. */
export async function gitArchive(runner: CommandRunner, git: string, repoPath: string, ref: string): Promise<ArchiveFile[]> {
  const { stdout } = await runChecked(
    runner,
    git,
    ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'safe.directory=*', '-C', repoPath, 'archive', '--format=tar', ref],
    { timeoutMs: 120_000 },
  );
  return readTar(stdout);
}

/**
 * The ref of a ticket branch: the local `<id>`, or `origin/<id>` in a fresh clone (where git
 * creates only the default branch locally). The ticket branches are published content: they are
 * built by the qa branch's scripts/build-tickets.sh, never by hand.
 */
export async function resolveBranchRef(runner: CommandRunner, git: string, repoPath: string, branch: string): Promise<string> {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    const result = await runner(git, ['-c', 'safe.directory=*', '-C', repoPath, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      timeoutMs: 30_000,
    });
    if (result.code === 0) {
      return ref;
    }
  }
  throw new Error(
    `${repoPath} has no ${branch} branch (neither local nor origin/${branch}). Run "git -C ${repoPath} fetch origin"; build the ticket branches with scripts/build-tickets.sh.`,
  );
}

/**
 * Text files are normalized to LF: a Windows checkout with core.autocrlf=true has CRLF in its
 * working tree, and the package must be byte-identical on every platform (and git apply needs LF).
 */
export function normalizeLineEndings(data: Buffer): Buffer {
  return data.includes(0) || !data.includes(13) ? data : Buffer.from(data.toString('utf8').replace(/\r\n/g, '\n'));
}
