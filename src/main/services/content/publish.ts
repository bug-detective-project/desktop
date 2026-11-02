/**
 * Builds a project's manifest from its qa folder (a worktree of the qa branch) and the ticket
 * branches of the same repository, and publishes it: manifest.json, one tag per new ticket commit
 * and a commit on qa. Used by tools/publish-project.ts and, in memory, by the local content source.
 * Never pushes: publishing ends with the push command for the author to run.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runChecked } from '../process.ts';
import type { CommandRunner } from '../process.ts';
import { sha256Hex, treeDigest } from './archive.ts';
import type { ArchiveFile } from './archive.ts';
import { gitArchive, normalizeLineEndings, resolveBranchRef } from './git.ts';
import { PACKAGE_EXCLUDED, TICKET_ID, TRACKS, compareVersions, parseManifest } from './manifest.ts';
import { projectContentOf } from './project-files.ts';
import type { ProjectManifest, TicketEntry } from './manifest.ts';
import { repositoryFromRemote, updateCatalog } from '../projects.ts';
import type { CatalogProject } from '../projects.ts';

/** Files and folders every tickets/<id>/ must have. */
export const REQUIRED_TICKET_FILES = [
  'bug.patch',
  'gate1/',
  'gate2/',
  'ticket.en.md',
  'ticket.pt.md',
  'hints.en.json',
  'hints.pt.json',
  'reference.patch',
  'review.en.md',
  'review.pt.md',
  'solution.en.md',
  'solution.pt.md',
];

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

export interface BuildManifestOptions {
  qaDir: string;
  version: string;
  runner: CommandRunner;
  git?: string;
  now?: string;
}

interface Git {
  text(...args: string[]): Promise<string>;
}

function gitIn(runner: CommandRunner, git: string, dir: string): Git {
  return {
    text: async (...args) => (await runChecked(runner, git, ['-c', 'safe.directory=*', '-C', dir, ...args])).stdout.toString('utf8').trim(),
  };
}

const DIFFICULTIES = ['beginner', 'intermediate', 'advanced'] as const;

async function readProject(qaDir: string): Promise<{ id: string; name: string; difficulty?: (typeof DIFFICULTIES)[number] }> {
  let json: { bugDetective?: { project?: { id?: unknown; name?: unknown; difficulty?: unknown } } };
  try {
    json = JSON.parse(await readFile(join(qaDir, 'package.json'), 'utf8'));
  } catch {
    throw new Error(`${qaDir}/package.json is missing or is not valid JSON`);
  }
  const project = json.bugDetective?.project;
  if (typeof project?.id !== 'string' || typeof project.name !== 'string') {
    throw new Error(`${qaDir}/package.json has no bugDetective.project { id, name }`);
  }
  const { difficulty } = project;
  if (difficulty !== undefined && !DIFFICULTIES.includes(difficulty as (typeof DIFFICULTIES)[number])) {
    throw new Error(`${qaDir}/package.json: bugDetective.project.difficulty must be one of ${DIFFICULTIES.join(', ')}`);
  }
  return { id: project.id, name: project.name, ...(difficulty !== undefined && { difficulty: difficulty as (typeof DIFFICULTIES)[number] }) };
}

/** The committed files of tickets/ (untracked files never reach the qa branch, so they never count). */
async function trackedTicketFiles(git: Git): Promise<string[]> {
  const output = await git.text('ls-files', '-z', '--', 'tickets');
  return output.split('\0').filter(Boolean);
}

/** The ticket ids in queue order: every front ticket, then every back ticket. */
function ticketQueue(files: string[]): string[] {
  const folders = [...new Set(files.map((file) => file.split('/')[1]))];
  for (const folder of folders) {
    if (!TICKET_ID.test(folder)) {
      throw new Error(`tickets/${folder}: a ticket folder must be named front-<n> or back-<n>`);
    }
  }
  return TRACKS.flatMap((track) => {
    const orders = folders
      .filter((folder) => folder.startsWith(`${track}-`))
      .map((folder) => Number(folder.slice(track.length + 1)))
      .sort((a, b) => a - b);
    orders.forEach((order, index) => {
      if (order !== index + 1) {
        throw new Error(`tickets/: the ${track} tickets must be numbered 1, 2, 3, ... without gaps (found ${track}-${order})`);
      }
    });
    return orders.map((order) => `${track}-${order}`);
  });
}

/** The player's package of a ticket: its committed files without PACKAGE_EXCLUDED, with LF line endings. */
async function ticketPackage(qaDir: string, id: string, files: string[]): Promise<ArchiveFile[]> {
  const prefix = `tickets/${id}/`;
  const own = files.filter((file) => file.startsWith(prefix)).map((file) => file.slice(prefix.length));
  for (const required of REQUIRED_TICKET_FILES) {
    const present = required.endsWith('/') ? own.some((file) => file.startsWith(required)) : own.includes(required);
    if (!present) {
      throw new Error(`tickets/${id} has no ${required}`);
    }
  }
  const result: ArchiveFile[] = [];
  for (const path of own.filter((file) => !PACKAGE_EXCLUDED.has(file))) {
    const data = normalizeLineEndings(await readFile(join(qaDir, ...prefix.split('/'), ...path.split('/'))));
    result.push({ path, data: new Uint8Array(data), executable: false });
  }
  return result;
}

/**
 * Every committed file of the qa folder, read from disk with LF line endings (the content a
 * download of the qa branch gives, before it is published).
 */
export async function readQaFiles(qaDir: string, runner: CommandRunner, git = 'git'): Promise<ArchiveFile[]> {
  const paths = (await gitIn(runner, git, qaDir).text('ls-files', '-z')).split('\0').filter(Boolean);
  const files: ArchiveFile[] = [];
  for (const path of paths) {
    const data = await readFile(join(qaDir, ...path.split('/'))).catch(() => null);
    if (data) {
      files.push({ path, data: new Uint8Array(normalizeLineEndings(data)), executable: false });
    }
  }
  return files;
}

/** The verified-content view of one ticket's package, as the manifest describes it. */
export async function readTicketPackage(qaDir: string, id: string, runner: CommandRunner, git = 'git'): Promise<ArchiveFile[]> {
  return ticketPackage(qaDir, id, await trackedTicketFiles(gitIn(runner, git, qaDir)));
}

/** Reads the qa folder and the ticket branches into a manifest. Writes nothing. */
export async function buildManifest(options: BuildManifestOptions): Promise<ProjectManifest> {
  const { qaDir, version, runner, git: gitCommand = 'git' } = options;
  if (!SEMVER.test(version)) {
    throw new Error(`Invalid version ${version}: use X.Y.Z`);
  }
  const project = await readProject(qaDir);
  const git = gitIn(runner, gitCommand, qaDir);
  // The story and the review configuration must be valid before anything is published.
  const projectFiles = (await readQaFiles(qaDir, runner, gitCommand)).filter((file) => !file.path.startsWith('tickets/'));
  projectContentOf(projectFiles);
  const files = await trackedTicketFiles(git);
  const queue = ticketQueue(files);
  if (queue.length === 0) {
    throw new Error(`${qaDir}/tickets has no ticket folders`);
  }

  const entries: TicketEntry[] = [];
  for (const id of queue) {
    const packageFiles = await ticketPackage(qaDir, id, files);
    const ref = await resolveBranchRef(runner, gitCommand, qaDir, id);
    const commit = await git.text('rev-parse', `${ref}^{commit}`);
    const codeFiles = await gitArchive(runner, gitCommand, qaDir, commit);
    const existing = (await git.text('tag', '--points-at', commit, '--sort=-v:refname', '-l', `${id}-v*`)).split('\n').filter(Boolean)[0];
    const [track, order] = id.split('-');
    entries.push({
      id,
      track: track as TicketEntry['track'],
      order: Number(order),
      branch: id,
      tag: existing ?? `${id}-v${version}`,
      commit,
      commitMessage: await git.text('log', '-1', '--format=%s', commit),
      codeDigest: treeDigest(codeFiles),
      codeFiles: codeFiles.length,
      package: { path: `tickets/${id}`, files: packageFiles.length, digest: treeDigest(packageFiles) },
    });
  }

  return parseManifest({
    format: 'bug-detective-project',
    formatVersion: 1,
    project,
    version,
    createdAt: options.now ?? new Date().toISOString(),
    tickets: {
      total: entries.length,
      front: entries.filter((entry) => entry.track === 'front').length,
      back: entries.filter((entry) => entry.track === 'back').length,
    },
    entries,
  });
}

export interface PublishOptions {
  qaDir: string;
  version: string;
  runner: CommandRunner;
  git?: string;
  dryRun?: boolean;
  log?: (line: string) => void;
  /** desktop/content/projects.json: after publishing, the project's entry gets the new version (added when new). */
  catalogFile?: string;
}

/** Writes manifest.json, creates the missing tags and commits on qa. Returns the push command to run. */
export async function publishProject(options: PublishOptions): Promise<{ manifest: ProjectManifest; pushCommand: string }> {
  const { qaDir, version, runner, git: gitCommand = 'git', log = () => {} } = options;
  const git = gitIn(runner, gitCommand, qaDir);
  const manifestPath = join(qaDir, 'manifest.json');

  const published = await readFile(manifestPath, 'utf8').then(
    (text) => (JSON.parse(text) as { version?: string }).version,
    () => undefined,
  );
  if (!SEMVER.test(version)) {
    throw new Error(`Invalid version ${version}: use X.Y.Z`);
  }
  if (published && SEMVER.test(published) && compareVersions(version, published) <= 0) {
    throw new Error(`The version must be newer than the published ${published} (got ${version})`);
  }
  if (await git.text('tag', '-l', `*-v${version}`)) {
    throw new Error(`Tags for version ${version} already exist`);
  }

  // The players download the committed tickets/, so the manifest must describe exactly those files.
  const dirty = await git.text('status', '--porcelain', '--untracked-files=no', '--', 'tickets');
  if (dirty) {
    throw new Error(`Commit the ticket files first; these are not committed:\n${dirty}`);
  }
  const manifest = await buildManifest({ qaDir, version, runner, git: gitCommand });
  const branches = manifest.entries.map((entry) => entry.branch).join(' ');
  // Only this project's ticket tags: a clone may carry other tags that must not be published.
  const tags = [...new Set(manifest.entries.map((entry) => entry.tag))].join(' ');
  const pushCommand = `git push origin main qa ${branches} --force-with-lease && git push origin ${tags}`;
  if (options.dryRun) {
    return { manifest, pushCommand };
  }

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  for (const entry of manifest.entries) {
    if (!(await git.text('tag', '-l', entry.tag))) {
      await git.text('tag', entry.tag, entry.commit);
      log(`${entry.id}: tagged ${entry.commit.slice(0, 12)} as ${entry.tag}`);
    }
  }
  await git.text('add', 'manifest.json');
  // Only the manifest: anything else the author has staged stays staged.
  await git.text('commit', '-q', '-m', `Publish ${manifest.project.name} ${version}`, '--', 'manifest.json');
  log(`manifest.json committed on qa (sha256 ${sha256Hex(await readFile(manifestPath)).slice(0, 12)})`);
  if (options.catalogFile) {
    const repository = repositoryFromRemote(await git.text('remote', 'get-url', 'origin'));
    const catalog = JSON.parse(await readFile(options.catalogFile, 'utf8')) as { projects: CatalogProject[] };
    const updated = updateCatalog(catalog, { id: manifest.project.id, repository, version });
    await writeFile(options.catalogFile, `${JSON.stringify(updated, null, 2)}\n`);
    log(`${options.catalogFile}: ${manifest.project.id} ${version} (${repository})`);
  }
  return { manifest, pushCommand };
}
