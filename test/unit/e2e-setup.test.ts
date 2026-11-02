/**
 * How the e2e tests find SupportDesk (test/e2e/global-setup.ts): the local ../supportdesk-qa
 * when it exists, otherwise a pinned published version cloned once into test/.cache/. A notes
 * project with a published manifest and a qa-v1.0.0 tag stands in for GitHub.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildManifest } from '../../src/main/services/content/local-manifest.ts';
import { runCommand } from '../../src/main/services/process.ts';
import { resolveSupportdesk } from '../e2e/global-setup.ts';
import { createNotesProject } from '../helpers/notes-project.ts';
import type { ProjectRepo } from '../helpers/project-repo.ts';

let dir: string;
let remote: ProjectRepo;
let published: Record<string, string>;
let clones: number;
const clone = async (_url: string, to: string) => {
  clones += 1;
  execFileSync('git', ['clone', '-q', '--branch', 'qa-v1.0.0', remote.projectDir, to], { stdio: 'pipe' });
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bugdetective-e2e-setup-'));
  remote = await createNotesProject(join(dir, 'remote'));
  const manifest = await buildManifest({ qaDir: remote.qaDir, version: '1.0.0', runner: runCommand });
  published = Object.fromEntries(manifest.entries.map((entry) => [entry.id, entry.commit]));
  await writeFile(join(remote.qaDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  remote.git(remote.qaDir, 'add', '-A');
  remote.git(remote.qaDir, 'commit', '-q', '-m', 'Publish 1.0.0');
  remote.git(remote.qaDir, 'tag', 'qa-v1.0.0');
  // After the publication the ticket branch moves on (a pull request in progress).
  remote.git(remote.projectDir, 'checkout', '-q', 'front-1');
  await writeFile(join(remote.projectDir, 'later.txt'), 'not published\n');
  remote.git(remote.projectDir, 'add', '-A');
  remote.git(remote.projectDir, 'commit', '-q', '-m', 'Work in progress');
  remote.git(remote.projectDir, 'checkout', '-q', 'main');
  clones = 0;
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const options = () => ({ local: join(dir, 'supportdesk-qa'), cache: join(dir, 'cache'), ref: 'qa-v1.0.0', clone });

describe('resolveSupportdesk', () => {
  it('uses the local folder when it exists, without cloning', async () => {
    await mkdir(join(dir, 'supportdesk-qa'));
    await writeFile(join(dir, 'supportdesk-qa', 'package.json'), '{}\n');
    expect(await resolveSupportdesk(options())).toEqual({ qaDir: join(dir, 'supportdesk-qa'), pinned: false });
    expect(clones).toBe(0);
  });

  it('clones the pinned version once and reuses it', async () => {
    const first = await resolveSupportdesk(options());
    expect(first).toEqual({ qaDir: join(dir, 'cache', 'supportdesk-qa-v1.0.0'), pinned: true });
    expect(existsSync(join(first.qaDir, 'manifest.json'))).toBe(true);
    expect(await resolveSupportdesk(options())).toEqual(first);
    expect(clones).toBe(1);
  });

  it('points each ticket branch at its published commit, not at the branch tip', async () => {
    const { qaDir } = await resolveSupportdesk(options());
    for (const [id, commit] of Object.entries(published)) {
      expect(execFileSync('git', ['-C', qaDir, 'rev-parse', `refs/heads/${id}`], { encoding: 'utf8' }).trim()).toBe(commit);
    }
    expect(existsSync(join(qaDir, 'later.txt'))).toBe(false);
  });

  it('clones again over a broken cache', async () => {
    await mkdir(join(dir, 'cache', 'supportdesk-qa-v1.0.0'), { recursive: true });
    await writeFile(join(dir, 'cache', 'supportdesk-qa-v1.0.0', 'half.txt'), 'interrupted\n');
    const { qaDir } = await resolveSupportdesk(options());
    expect(clones).toBe(1);
    expect(existsSync(join(qaDir, 'manifest.json'))).toBe(true);
  });

  it('without the local folder and without network, fails with what to do', async () => {
    const offline = async () => {
      throw new Error('Could not resolve host: github.com');
    };
    await expect(resolveSupportdesk({ ...options(), clone: offline })).rejects.toThrow(/\.\.\/supportdesk-qa[\s\S]*internet/);
    expect(existsSync(join(dir, 'cache', 'supportdesk-qa-v1.0.0'))).toBe(false);
  });
});
