/**
 * The notes fixture (test/fixtures/notes) laid out like a published project, in a temporary
 * folder: `main` from main/, the `qa` worktree from qa/ plus tickets/<id>/, and one single-commit
 * branch per ticket (main with the file from tickets/<id>/buggy/). Each ticket's bug.patch and
 * reference.patch are made here with git, and its gate1/ is main's test/ folder.
 */
import { execFileSync } from 'node:child_process';
import { cp, readdir, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import type { ProjectRepo } from './project-repo.ts';

export const NOTES_FIXTURE = resolve(import.meta.dirname, '..', 'fixtures', 'notes');
export const NOTES_TICKETS = ['front-1', 'front-2', 'back-1'] as const;
const TICKET_TEXTS = ['ticket.en.md', 'ticket.pt.md', 'hints.en.json', 'hints.pt.json', 'review.en.md', 'review.pt.md', 'solution.en.md', 'solution.pt.md'];

async function filesUnder(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}

export async function createNotesProject(dir: string): Promise<ProjectRepo> {
  const projectDir = join(dir, 'notes');
  const qaDir = join(dir, 'notes-qa');
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  await cp(join(NOTES_FIXTURE, 'main'), projectDir, { recursive: true });
  git(projectDir, 'init', '-q', '-b', 'main');
  git(projectDir, 'config', 'user.name', 'Test');
  git(projectDir, 'config', 'user.email', 'test@example.com');
  git(projectDir, 'config', 'commit.gpgsign', 'false');
  git(projectDir, 'config', 'tag.gpgsign', 'false');
  git(projectDir, 'add', '-A');
  git(projectDir, 'commit', '-q', '-m', 'Notes app');

  const patches: Record<string, { bug: string; reference: string }> = {};
  for (const id of NOTES_TICKETS) {
    const ticket = join(NOTES_FIXTURE, 'tickets', id);
    git(projectDir, 'checkout', '-q', '--orphan', id, 'main');
    await cp(join(ticket, 'buggy'), projectDir, { recursive: true });
    git(projectDir, 'add', '-A');
    git(projectDir, 'commit', '-q', '-m', `Notes release ${id}`);
    const bug = `${git(projectDir, 'diff', '--binary', 'main', id)}\n`;
    // The fix, plus the ticket's regression test as a new file (it joins gate1 of later tickets).
    for (const file of await filesUnder(join(ticket, 'buggy'))) {
      git(projectDir, 'checkout', '-q', 'main', '--', file);
    }
    await cp(join(ticket, 'regression'), join(projectDir, 'test'), { recursive: true });
    git(projectDir, 'add', '-A');
    const reference = `${git(projectDir, 'diff', '--binary', '--cached', id)}\n`;
    git(projectDir, 'reset', '-q', '--hard');
    git(projectDir, 'clean', '-q', '-f', '-d');
    patches[id] = { bug, reference };
  }
  git(projectDir, 'checkout', '-q', 'main');

  // `worktree add --orphan` needs git 2.42; this works on older versions too.
  git(projectDir, 'worktree', 'add', '-q', '--detach', qaDir, 'main');
  git(qaDir, 'checkout', '-q', '--orphan', 'qa');
  git(qaDir, 'rm', '-r', '-q', '-f', '.');
  await cp(join(NOTES_FIXTURE, 'qa'), qaDir, { recursive: true });
  for (const id of NOTES_TICKETS) {
    const from = join(NOTES_FIXTURE, 'tickets', id);
    const to = join(qaDir, 'tickets', id);
    for (const file of TICKET_TEXTS) {
      await cp(join(from, file), join(to, file));
    }
    await cp(join(from, 'gate2'), join(to, 'gate2'), { recursive: true });
    await cp(join(NOTES_FIXTURE, 'main', 'test'), join(to, 'gate1', 'test'), { recursive: true });
    await writeFile(join(to, 'bug.patch'), patches[id].bug);
    await writeFile(join(to, 'reference.patch'), patches[id].reference);
  }
  git(qaDir, 'add', '-A');
  git(qaDir, 'commit', '-q', '-m', 'QA suite');
  return { projectDir, qaDir, git };
}
