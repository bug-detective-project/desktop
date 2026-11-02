/**
 * The notes fixture's QA CLI (test/fixtures/notes/qa/run.ts), run outside Docker against stages
 * exported from the repository createNotesProject builds: the same contract as SupportDesk's CLI.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { countsOf, projectContentOf } from '@bug-detective/catalog/contract';
import { LocalContentSource } from '../../src/main/services/content/local.ts';
import { runCommand } from '../../src/main/services/process.ts';
import { parseQaResult } from '../../src/main/services/qa.ts';
import type { QaResult } from '../../src/shared/types.ts';
import { createNotesProject } from '../helpers/notes-project.ts';
import type { ProjectRepo } from '../helpers/project-repo.ts';

const run = promisify(execFile);

let dir: string;
let notes: ProjectRepo;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bugdetective-notes-cli-'));
  notes = await createNotesProject(dir);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A ticket's code as the player gets it, and its package (the ticket folder without bug.patch). */
async function stage(id: string): Promise<{ workspace: string; packageDir: string }> {
  const root = await mkdtemp(join(dir, `${id}-`));
  const workspace = join(root, 'workspace');
  const packageDir = join(root, 'package');
  await mkdir(workspace);
  await run('sh', ['-c', `git -C "${notes.projectDir}" archive ${id} | tar -x -C "${workspace}"`]);
  await cp(join(notes.qaDir, 'tickets', id), packageDir, { recursive: true, filter: (source) => !source.endsWith('bug.patch') });
  return { workspace, packageDir };
}

async function qa(ticket: number, paths: { workspace: string; packageDir: string }, timeoutSeconds = 60): Promise<QaResult> {
  const out = join(paths.workspace, '..', 'result.json');
  await run(process.execPath, [join(notes.qaDir, 'run.ts'), '--ticket', String(ticket), '--workspace', paths.workspace, '--package', paths.packageDir, '--lang', 'en', '--json', out, '--timeout', String(timeoutSeconds)]).catch(() => {});
  // parseQaResult is the desktop's own check of the result file (its schema and the ticket).
  return parseQaResult(await readFile(out, 'utf8'), ticket);
}

async function applyReference(id: string, workspace: string): Promise<void> {
  await run('git', ['apply', join(notes.qaDir, 'tickets', id, 'reference.patch')], { cwd: workspace });
}

describe('notes project', () => {
  it('is valid content for the desktop: three tickets, its story and its review configuration', async () => {
    const content = await new LocalContentSource({ qaDir: notes.qaDir, runner: runCommand }).prepare();
    expect(content.manifest.project.id).toBe('notes');
    expect(countsOf(content.manifest)).toEqual({ front: 2, back: 1 });
    expect(projectContentOf(content.qaFiles).story.en.project.name).toBe('Notes');
    const fetched = await new LocalContentSource({ qaDir: notes.qaDir, runner: runCommand }).fetchTicket('back-1');
    expect(fetched.entry.commitMessage).toBe('Notes release back-1');
  });
});

describe('notes QA CLI', () => {
  it('the buggy stage passes gate 1 and fails gate 2', async () => {
    const result = await qa(1, await stage('front-1'));
    expect(result).toMatchObject({ ticket: 1, gate: 2, status: 'failed' });
    expect(result.tests.some((test) => test.status === 'failed')).toBe(true);
  });

  it('the reference patch passes both gates', async () => {
    const paths = await stage('front-1');
    await applyReference('front-1', paths.workspace);
    expect(await qa(1, paths)).toMatchObject({ ticket: 1, gate: 2, status: 'passed' });
  });

  it('breaking a regression test fails gate 1', async () => {
    const paths = await stage('back-1');
    await writeFile(join(paths.workspace, 'client', 'sort.js'), 'export function sortNotes(notes) {\n  return notes;\n}\n');
    expect(await qa(3, paths)).toMatchObject({ ticket: 3, gate: 1, status: 'failed' });
  });

  it('an infinite loop is a timeout', async () => {
    const paths = await stage('front-1');
    await writeFile(join(paths.workspace, 'client', 'notes.js'), 'while (true) {}\nexport function titleOf() {}\n');
    const started = Date.now();
    expect(await qa(1, paths, 3)).toMatchObject({ ticket: 1, status: 'timeout' });
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it('the workspace copy ignores node_modules and .git', async () => {
    const paths = await stage('front-1');
    await applyReference('front-1', paths.workspace);
    for (const folder of ['node_modules', '.git']) {
      await mkdir(join(paths.workspace, folder, 'test'), { recursive: true });
      await writeFile(join(paths.workspace, folder, 'test', 'broken.test.js'), "throw new Error('copied by mistake');\n");
    }
    expect(await qa(1, paths)).toMatchObject({ gate: 2, status: 'passed' });
  });

  it('--deps-only stores the dependencies under the key the workspace computes', async () => {
    const { workspace } = await stage('front-1');
    const cache = join(workspace, '..', 'deps');
    await run(process.execPath, [join(notes.qaDir, 'run.ts'), '--ticket', '1', '--workspace', workspace, '--deps-cache', cache, '--deps-only', '--timeout', '120']);
    // Workspace.dependencyKey: SHA-256 of the lockfile and the Node runtime.
    const key = createHash('sha256')
      .update(await readFile(join(workspace, 'package-lock.json')))
      .update(`\0${process.version}\0${process.platform}\0${process.arch}`)
      .digest('hex');
    const { stdout } = await run('tar', ['-tf', join(cache, `${key}.tar`)]);
    expect(stdout.split('\n')).toContain('node_modules/');
  });

  it('writes its messages in the language asked for', async () => {
    const paths = await stage('front-1');
    const out = join(paths.workspace, '..', 'result-pt.json');
    await run(process.execPath, [join(notes.qaDir, 'run.ts'), '--ticket', '1', '--workspace', paths.workspace, '--package', paths.packageDir, '--lang', 'pt', '--json', out]).catch(() => {});
    expect(parseQaResult(await readFile(out, 'utf8'), 1).message).toMatch(/gate 2/i);
    expect(parseQaResult(await readFile(out, 'utf8'), 1).message).toMatch(/falhou/);
  });
});
