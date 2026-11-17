import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildManifest } from '../../src/main/services/content/local-manifest.ts';
import { runCommand } from '../../src/main/services/process.ts';
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

const build = () => buildManifest({ qaDir: repo.qaDir, version: '1.0.0', runner: runCommand });

describe('buildManifest (the local content source)', () => {
  it('describes every ticket: its branch commit, code and package', async () => {
    const manifest = await build();
    expect(manifest.project).toEqual({ id: 'demo', name: 'Demo' });
    expect(manifest.tickets).toEqual({ total: 3, front: 2, back: 1 });
    expect(manifest.entries.map((entry) => entry.id)).toEqual(['front-1', 'front-2', 'back-1']);
    expect(manifest.entries[0].commit).toBe(repo.git(repo.qaDir, 'rev-parse', 'front-1'));
    expect(manifest.entries[0].package).toMatchObject({ path: 'tickets/front-1', files: 11 });
  });

  it('copies ticket.json into the entry of its ticket, and only of that one', async () => {
    const meta = { type: 'build', bothSides: true, skills: { en: ['Building components'], pt: ['Criação de componentes'] } };
    await writeFile(join(repo.qaDir, 'tickets', 'front-1', 'ticket.json'), `${JSON.stringify(meta)}\n`);
    repo.git(repo.qaDir, 'add', 'tickets/front-1/ticket.json');
    repo.git(repo.qaDir, 'commit', '-q', '-m', 'Describe front-1');

    const manifest = await build();
    expect(manifest.entries[0]).toMatchObject(meta);
    expect(manifest.entries[0].package.files).toBe(12);
    for (const entry of manifest.entries.slice(1)) {
      expect(entry).not.toHaveProperty('type');
      expect(entry).not.toHaveProperty('bothSides');
      expect(entry).not.toHaveProperty('skills');
    }
  });

  it('refuses an invalid ticket.json, naming the file', async () => {
    await writeFile(join(repo.qaDir, 'tickets', 'back-1', 'ticket.json'), '{"type":"bug"}\n');
    repo.git(repo.qaDir, 'add', 'tickets/back-1/ticket.json');
    repo.git(repo.qaDir, 'commit', '-q', '-m', 'Describe back-1');
    await expect(build()).rejects.toThrow(/Invalid tickets\/back-1\/ticket\.json: type/);
  });

  it('refuses a ticket without a required file', async () => {
    repo.git(repo.qaDir, 'rm', '-q', 'tickets/front-2/reference.patch');
    repo.git(repo.qaDir, 'commit', '-q', '-m', 'Drop the patch');
    await expect(build()).rejects.toThrow(/front-2.*reference\.patch/);
  });

  it('refuses a ticket without a branch', async () => {
    repo.git(repo.projectDir, 'branch', '-q', '-D', 'back-1');
    await expect(build()).rejects.toThrow(/back-1/);
  });

  it('refuses a ticket folder with an invalid name', async () => {
    repo.git(repo.qaDir, 'mv', 'tickets/front-2', 'tickets/front-02');
    repo.git(repo.qaDir, 'commit', '-q', '-m', 'Rename');
    await expect(build()).rejects.toThrow(/front-02/);
  });

  it('ignores files that are not committed in a ticket folder', async () => {
    const before = (await build()).entries[0].package;
    await writeFile(join(repo.qaDir, 'tickets', 'front-1', 'notes.tmp'), 'scratch\n');
    expect((await build()).entries[0].package).toEqual(before);
  });

  it('gives the same digest for CRLF files on disk as for LF files', async () => {
    const before = (await build()).entries[0].package.digest;
    await writeFile(join(repo.qaDir, 'tickets', 'front-1', 'ticket.en.md'), '# front-1\r\n');
    expect((await build()).entries[0].package.digest).toBe(before);
  });

  it('refuses a qa branch without its story or with an invalid review configuration', async () => {
    repo.git(repo.qaDir, 'rm', '-q', 'story.pt.json');
    repo.git(repo.qaDir, 'commit', '-q', '-m', 'Drop the story');
    await expect(build()).rejects.toThrow(/story\.pt\.json/);
    repo.git(repo.qaDir, 'checkout', '-q', 'HEAD~1', '--', 'story.pt.json');
    await writeFile(join(repo.qaDir, 'review.json'), '{ "exclude": "not a list" }\n');
    repo.git(repo.qaDir, 'add', '-A');
    repo.git(repo.qaDir, 'commit', '-q', '-m', 'Bad review');
    await expect(build()).rejects.toThrow(/review/);
  });

  it('copies the project difficulty into the manifest, and refuses an unknown one', async () => {
    const write = async (difficulty: string) => {
      const file = join(repo.qaDir, 'package.json');
      const json = JSON.parse(await readFile(file, 'utf8'));
      json.bugDetective.project.difficulty = difficulty;
      await writeFile(file, JSON.stringify(json));
    };
    await write('intermediate');
    expect((await build()).project.difficulty).toBe('intermediate');
    await write('hard');
    await expect(build()).rejects.toThrow(/difficulty/);
  });

  it('refuses a qa folder without package.json', async () => {
    await unlink(join(repo.qaDir, 'package.json')).catch(() => {});
    await expect(build()).rejects.toThrow(/package\.json/);
  });
});
