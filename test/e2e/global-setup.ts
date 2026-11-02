/**
 * Finds the SupportDesk the e2e tests play: the local ../supportdesk-qa worktree when it exists,
 * otherwise the pinned publication (supportdesk-version.ts) cloned once into test/.cache/, with a
 * local branch per ticket at its published commit (the local content source reads branches).
 * The choice is written to test/.cache/supportdesk.json, which fixtures.ts reads.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { SUPPORTDESK_QA_REF, SUPPORTDESK_URL } from './supportdesk-version.ts';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..', '..');
export const SUPPORTDESK_CHOICE_FILE = join(root, 'test', '.cache', 'supportdesk.json');

export interface SupportdeskChoice {
  qaDir: string;
  /** The pinned publication, not the local folder. */
  pinned: boolean;
}

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await run('git', ['-C', dir, ...args])).stdout.trim();
}

/** The published ticket commits of the clone's manifest.json. */
async function publishedCommits(dir: string): Promise<{ id: string; commit: string }[]> {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as { entries: { id: string; commit: string }[] };
  return manifest.entries.map(({ id, commit }) => ({ id, commit }));
}

/** A finished clone: checked out at the ref, with every ticket branch at its published commit. */
async function validClone(dir: string, ref: string): Promise<boolean> {
  try {
    if ((await git(dir, 'rev-parse', 'HEAD')) !== (await git(dir, 'rev-parse', `${ref}^{commit}`))) {
      return false;
    }
    for (const { id, commit } of await publishedCommits(dir)) {
      if ((await git(dir, 'rev-parse', `refs/heads/${id}`)) !== commit) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export async function resolveSupportdesk(options: { local: string; cache: string; ref: string; clone(url: string, dir: string): Promise<void> }): Promise<SupportdeskChoice> {
  if (existsSync(join(options.local, 'package.json'))) {
    return { qaDir: options.local, pinned: false };
  }
  const dir = join(options.cache, `supportdesk-${options.ref}`);
  if (!(await validClone(dir, options.ref))) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(options.cache, { recursive: true });
    try {
      await options.clone(SUPPORTDESK_URL, dir);
      for (const { id, commit } of await publishedCommits(dir)) {
        await git(dir, 'branch', '-f', id, commit);
      }
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw new Error(
        `The e2e tests need SupportDesk: put its qa worktree next to the desktop (../supportdesk-qa, see "Getting the SupportDesk repository" in README.md), ` +
          `or run them once with internet access to download ${options.ref}. ${(error as Error).message}`,
        { cause: error },
      );
    }
  }
  return { qaDir: dir, pinned: true };
}

export default async function globalSetup(): Promise<void> {
  const choice = await resolveSupportdesk({
    // BUGDETECTIVE_E2E_PINNED_SUPPORTDESK=1 plays the pinned publication even with the local folder there.
    local: process.env.BUGDETECTIVE_E2E_PINNED_SUPPORTDESK === '1' ? join(root, 'test', '.cache', 'no-local-supportdesk') : resolve(root, '..', 'supportdesk-qa'),
    cache: join(root, 'test', '.cache'),
    ref: SUPPORTDESK_QA_REF,
    clone: async (url, dir) => {
      await run('git', ['clone', '--quiet', '--branch', SUPPORTDESK_QA_REF, url, dir]);
    },
  });
  await mkdir(join(root, 'test', '.cache'), { recursive: true });
  await writeFile(SUPPORTDESK_CHOICE_FILE, `${JSON.stringify(choice, null, 2)}\n`);
  console.log(choice.pinned ? `SupportDesk: ${SUPPORTDESK_QA_REF} (pinned, ${choice.qaDir})` : `SupportDesk: ${choice.qaDir} (local)`);
}
