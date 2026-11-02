/**
 * A small game project in a temporary folder, laid out like a published one: a repository with
 * `main`, the `qa` branch checked out as a worktree (package.json with bugDetective.project and
 * tickets/<id>/ folders) and one orphan branch per ticket.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface TicketCounts {
  front: number;
  back: number;
}

export interface ProjectRepo {
  projectDir: string;
  qaDir: string;
  /** Runs git in a folder and returns its trimmed output. */
  git(dir: string, ...args: string[]): string;
}

/** The files every ticket folder must have (the content only matters to tests that use it). */
export function ticketFiles(id: string): Record<string, string> {
  return {
    'bug.patch': '',
    'gate1/app.test.txt': `gate1 ${id}\n`,
    'gate2/ticket.spec.txt': `gate2 ${id}\n`,
    'ticket.en.md': `# ${id}\n`,
    'ticket.pt.md': `# ${id} (pt)\n`,
    'hints.en.json': '{ "hints": ["a", "b", "c"] }\n',
    'hints.pt.json': '{ "hints": ["a", "b", "c"] }\n',
    'reference.patch': '',
    'review.en.md': 'Review\n',
    'review.pt.md': 'Revisão\n',
    'solution.en.md': 'Solution\n',
    'solution.pt.md': 'Solução\n',
  };
}

export async function writeFiles(dir: string, files: Record<string, string>): Promise<void> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(dir, path)), { recursive: true });
    await writeFile(join(dir, path), content);
  }
}

/** A valid story.<lang>.json for a test project, with one assignment message per ticket. */
export function projectStory(name: string, ids: string[], skills?: string[]): string {
  const message = (subject: string) => ({ subject, body: `${subject}.` });
  return `${JSON.stringify(
    {
      client: { name: 'Client', about: 'A client.', contacts: 'Someone', reporters: [{ name: 'Someone', role: 'Lead' }] },
      project: { name, about: `The ${name} app.`, stack: 'Text files', ...(skills && { skills }) },
      messages: {
        welcome: message('Welcome'),
        assignments: Object.fromEntries(ids.map((id) => [id, message(`Ticket ${id}`)])),
        completion: message('Done'),
        trackCompletion: message('Track {{track}} done'),
      },
    },
    null,
    2,
  )}\n`;
}

export function ticketIds(counts: TicketCounts): string[] {
  return [
    ...Array.from({ length: counts.front }, (_, i) => `front-${i + 1}`),
    ...Array.from({ length: counts.back }, (_, i) => `back-${i + 1}`),
  ];
}

/** What a test project may add to its brief: package.json bugDetective.project.stack and the story's skills. */
export interface ProjectBrief {
  stack?: { frontend?: string; backend?: string; database?: string };
  skills?: { en: string[]; pt: string[] };
}

export async function createProjectRepo(dir: string, counts: TicketCounts, name = 'Demo', id = name.toLowerCase(), brief: ProjectBrief = {}): Promise<ProjectRepo> {
  const projectDir = join(dir, id);
  const qaDir = join(dir, `${id}-qa`);
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'core.autocrlf=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  await mkdir(projectDir, { recursive: true });
  git(projectDir, 'init', '-q', '-b', 'main');
  git(projectDir, 'config', 'user.name', 'Test');
  git(projectDir, 'config', 'user.email', 'test@example.com');
  git(projectDir, 'config', 'commit.gpgsign', 'false');
  git(projectDir, 'config', 'tag.gpgsign', 'false');
  await writeFiles(projectDir, { 'package.json': '{ "name": "demo" }\n', 'app.txt': 'fixed\n' });
  git(projectDir, 'add', '-A');
  git(projectDir, 'commit', '-q', '-m', 'Demo app');

  // `worktree add --orphan` needs git 2.42; this works on older versions too.
  git(projectDir, 'worktree', 'add', '-q', '--detach', qaDir, 'main');
  git(qaDir, 'checkout', '-q', '--orphan', 'qa');
  git(qaDir, 'rm', '-r', '-q', '-f', '.');
  await writeFiles(qaDir, {
    'package.json': `${JSON.stringify({ name: 'demo-qa', bugDetective: { project: { id, name, ...(brief.stack && { stack: brief.stack }) } } }, null, 2)}\n`,
    'story.en.json': projectStory(name, ticketIds(counts), brief.skills?.en),
    'story.pt.json': projectStory(name, ticketIds(counts), brief.skills?.pt),
  });
  for (const id of ticketIds(counts)) {
    await writeFiles(join(qaDir, 'tickets', id), ticketFiles(id));
  }
  git(qaDir, 'add', '-A');
  git(qaDir, 'commit', '-q', '-m', 'QA suite');

  for (const id of ticketIds(counts)) {
    git(projectDir, 'checkout', '-q', '--orphan', id, 'main');
    await writeFile(join(projectDir, 'app.txt'), `bug ${id}\n`);
    git(projectDir, 'add', '-A');
    git(projectDir, 'commit', '-q', '-m', `${name} release ${id}`);
  }
  git(projectDir, 'checkout', '-q', 'main');
  return { projectDir, qaDir, git };
}
