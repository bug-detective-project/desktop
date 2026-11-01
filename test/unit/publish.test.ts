import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildManifest, publishProject } from '../../src/main/services/content/publish.ts';
import { runCommand } from '../../src/main/services/process.ts';
import type { CommandRunner } from '../../src/main/services/process.ts';
import { createProjectRepo } from '../helpers/project-repo.ts';
import type { ProjectRepo } from '../helpers/project-repo.ts';

let dir: string;
let repo: ProjectRepo;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bugdetective-publish-'));
  repo = await createProjectRepo(dir, { front: 2, back: 1 });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const tags = () => repo.git(repo.qaDir, 'tag', '-l').split('\n').filter(Boolean).sort();

describe('publishProject', () => {
  it('writes the manifest, tags every ticket and commits on qa', async () => {
    const { manifest } = await publishProject({ qaDir: repo.qaDir, version: '1.0.0', runner: runCommand });

    expect(manifest.project).toEqual({ id: 'demo', name: 'Demo' });
    expect(manifest.tickets).toEqual({ total: 3, front: 2, back: 1 });
    expect(manifest.entries.map((entry) => entry.id)).toEqual(['front-1', 'front-2', 'back-1']);
    expect(manifest.entries[0].commit).toBe(repo.git(repo.qaDir, 'rev-parse', 'front-1'));
    expect(manifest.entries[0].commitMessage).toBe('Demo release front-1');
    expect(manifest.entries[0].package).toMatchObject({ path: 'tickets/front-1', files: 11 });
    expect(JSON.parse(await readFile(join(repo.qaDir, 'manifest.json'), 'utf8'))).toEqual(manifest);
    expect(tags()).toEqual(['back-1-v1.0.0', 'front-1-v1.0.0', 'front-2-v1.0.0']);
    expect(repo.git(repo.qaDir, 'log', '-1', '--format=%s')).toBe('Publish Demo 1.0.0');
    expect(repo.git(repo.qaDir, 'status', '--porcelain')).toBe('');
  });

  it('keeps the earlier tag of a ticket whose commit did not change', async () => {
    await publishProject({ qaDir: repo.qaDir, version: '1.0.0', runner: runCommand });
    repo.git(repo.projectDir, 'checkout', '-q', 'front-2');
    await writeFile(join(repo.projectDir, 'app.txt'), 'bug front-2, again\n');
    repo.git(repo.projectDir, 'commit', '-q', '-am', 'Demo release front-2');
    repo.git(repo.projectDir, 'checkout', '-q', 'main');

    const { manifest } = await publishProject({ qaDir: repo.qaDir, version: '1.1.0', runner: runCommand });

    expect(manifest.entries.map((entry) => entry.tag)).toEqual(['front-1-v1.0.0', 'front-2-v1.1.0', 'back-1-v1.0.0']);
    expect(tags()).not.toContain('front-1-v1.1.0');
  });

  it('refuses a version that is not newer than the published one', async () => {
    await publishProject({ qaDir: repo.qaDir, version: '1.0.0', runner: runCommand });
    await expect(publishProject({ qaDir: repo.qaDir, version: '1.0.0', runner: runCommand })).rejects.toThrow(/version/);
    await expect(publishProject({ qaDir: repo.qaDir, version: '0.9.0', runner: runCommand })).rejects.toThrow(/version/);
  });

  it('refuses a ticket without a required file', async () => {
    repo.git(repo.qaDir, 'rm', '-q', 'tickets/front-2/reference.patch');
    repo.git(repo.qaDir, 'commit', '-q', '-m', 'Drop the patch');
    await expect(publishProject({ qaDir: repo.qaDir, version: '1.0.0', runner: runCommand })).rejects.toThrow(/front-2.*reference\.patch/);
  });

  it('refuses a ticket without a branch', async () => {
    repo.git(repo.projectDir, 'branch', '-q', '-D', 'back-1');
    await expect(publishProject({ qaDir: repo.qaDir, version: '1.0.0', runner: runCommand })).rejects.toThrow(/back-1/);
  });

  it('refuses a ticket folder with an invalid name', async () => {
    repo.git(repo.qaDir, 'mv', 'tickets/front-2', 'tickets/front-02');
    repo.git(repo.qaDir, 'commit', '-q', '-m', 'Rename');
    await expect(publishProject({ qaDir: repo.qaDir, version: '1.0.0', runner: runCommand })).rejects.toThrow(/front-02/);
  });

  it('ignores files that are not committed in a ticket folder', async () => {
    const before = (await buildManifest({ qaDir: repo.qaDir, version: '1.0.0', runner: runCommand })).entries[0].package;
    await writeFile(join(repo.qaDir, 'tickets', 'front-1', 'notes.tmp'), 'scratch\n');
    const after = (await buildManifest({ qaDir: repo.qaDir, version: '1.0.0', runner: runCommand })).entries[0].package;
    expect(after).toEqual(before);
  });

  it('gives the same digest for CRLF files on disk as for LF files', async () => {
    const before = (await buildManifest({ qaDir: repo.qaDir, version: '1.0.0', runner: runCommand })).entries[0].package.digest;
    await writeFile(join(repo.qaDir, 'tickets', 'front-1', 'ticket.en.md'), '# front-1\r\n');
    const after = (await buildManifest({ qaDir: repo.qaDir, version: '1.0.0', runner: runCommand })).entries[0].package.digest;
    expect(after).toBe(before);
  });

  it('refuses to publish ticket files that are not committed', async () => {
    await writeFile(join(repo.qaDir, 'tickets', 'front-1', 'ticket.en.md'), '# front-1, edited\n');
    await expect(publishProject({ qaDir: repo.qaDir, version: '1.0.0', runner: runCommand })).rejects.toThrow(/not committed.*tickets\/front-1\/ticket\.en\.md/s);
  });

  it('commits only the manifest, leaving other staged changes staged', async () => {
    await writeFile(join(repo.qaDir, 'notes.md'), 'draft\n');
    repo.git(repo.qaDir, 'add', 'notes.md');
    await publishProject({ qaDir: repo.qaDir, version: '1.0.0', runner: runCommand });
    expect(repo.git(repo.qaDir, 'show', '--name-only', '--format=', 'HEAD')).toBe('manifest.json');
    expect(repo.git(repo.qaDir, 'status', '--porcelain')).toBe('A  notes.md');
  });

  it('records the publication in projects.json: a new project, then its new version', async () => {
    repo.git(repo.projectDir, 'remote', 'add', 'origin', 'git@github.com:bug-detective-project/demo.git');
    const catalogFile = join(dir, 'projects.json');
    const starter = { id: 'supportdesk', repository: 'bug-detective-project/supportdesk', starter: true, version: '2.0.0' };
    await writeFile(catalogFile, JSON.stringify({ projects: [starter] }));

    await publishProject({ qaDir: repo.qaDir, version: '1.0.0', runner: runCommand, catalogFile });
    const demo = { id: 'demo', repository: 'bug-detective-project/demo', starter: false, version: '1.0.0' };
    expect(JSON.parse(await readFile(catalogFile, 'utf8'))).toEqual({ projects: [starter, demo] });

    await publishProject({ qaDir: repo.qaDir, version: '1.1.0', runner: runCommand, catalogFile });
    expect(JSON.parse(await readFile(catalogFile, 'utf8'))).toEqual({ projects: [starter, { ...demo, version: '1.1.0' }] });
  });

  it('leaves projects.json untouched in a dry run', async () => {
    repo.git(repo.projectDir, 'remote', 'add', 'origin', 'git@github.com:bug-detective-project/demo.git');
    const catalogFile = join(dir, 'projects.json');
    const before = JSON.stringify({ projects: [{ id: 'supportdesk', repository: 'bug-detective-project/supportdesk', starter: true, version: '2.0.0' }] });
    await writeFile(catalogFile, before);
    await publishProject({ qaDir: repo.qaDir, version: '1.0.0', runner: runCommand, catalogFile, dryRun: true });
    expect(await readFile(catalogFile, 'utf8')).toBe(before);
  });

  it('refuses a qa branch without its story or with an invalid review configuration', async () => {
    repo.git(repo.qaDir, 'rm', '-q', 'story.pt.json');
    repo.git(repo.qaDir, 'commit', '-q', '-m', 'Drop the story');
    await expect(publishProject({ qaDir: repo.qaDir, version: '1.0.0', runner: runCommand })).rejects.toThrow(/story\.pt\.json/);
    repo.git(repo.qaDir, 'checkout', '-q', 'HEAD~1', '--', 'story.pt.json');
    await writeFile(join(repo.qaDir, 'review.json'), '{ "exclude": "not a list" }\n');
    repo.git(repo.qaDir, 'add', '-A');
    repo.git(repo.qaDir, 'commit', '-q', '-m', 'Bad review');
    await expect(publishProject({ qaDir: repo.qaDir, version: '1.0.0', runner: runCommand })).rejects.toThrow(/review/);
  });

  it('writes nothing in a dry run', async () => {
    const head = repo.git(repo.qaDir, 'rev-parse', 'HEAD');
    const { manifest } = await publishProject({ qaDir: repo.qaDir, version: '1.0.0', runner: runCommand, dryRun: true });
    expect(manifest.tickets.total).toBe(3);
    await expect(readFile(join(repo.qaDir, 'manifest.json'))).rejects.toThrow();
    expect(tags()).toEqual([]);
    expect(repo.git(repo.qaDir, 'rev-parse', 'HEAD')).toBe(head);
  });

  it('prints the push command and never pushes', async () => {
    const commands: string[] = [];
    const spy: CommandRunner = (command, args, options) => {
      commands.push([command, ...args].join(' '));
      return runCommand(command, args, options);
    };
    const { pushCommand } = await publishProject({ qaDir: repo.qaDir, version: '1.0.0', runner: spy });
    expect(pushCommand).toBe(
      'git push origin main qa front-1 front-2 back-1 --force-with-lease && git push origin front-1-v1.0.0 front-2-v1.0.0 back-1-v1.0.0',
    );
    expect(commands.some((command) => / push( |$)/.test(command))).toBe(false);
  });

  it('refuses a qa folder without package.json', async () => {
    await unlink(join(repo.qaDir, 'package.json')).catch(() => {});
    await expect(buildManifest({ qaDir: repo.qaDir, version: '1.0.0', runner: runCommand })).rejects.toThrow(/package\.json/);
  });
});
