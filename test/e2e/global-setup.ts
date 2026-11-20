/**
 * Finds the project the e2e tests play, Smoke Desk: the local ../smokedesk-qa worktree when it
 * exists, otherwise the pinned publication (smokedesk-version.ts) cloned once into test/.cache/,
 * with a local branch per ticket at its published commit (the local content source reads
 * branches). The choice is written to test/.cache/smokedesk.json, which fixtures.ts reads.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { SMOKEDESK_QA_REF, SMOKEDESK_URL } from './smokedesk-version.ts';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..', '..');
export const PROJECT_CHOICE_FILE = join(root, 'test', '.cache', 'smokedesk.json');

export interface ProjectChoice {
  qaDir: string;
  /** The pinned publication, not the local folder. */
  pinned: boolean;
}

async function git(dir: string, ...args: string[]): Promise<string> {
  return (await run('git', ['-C', dir, ...args])).stdout.trim();
}

/** The published ticket commits of the clone's manifest.json. */
async function publishedCommits(dir: string): Promise<{ id: string; commit: string }[]> {
  const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as {
    entries: { id: string; commit: string }[];
  };
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

export async function resolveProject(options: {
  local: string;
  cache: string;
  ref: string;
  clone(url: string, dir: string): Promise<void>;
}): Promise<ProjectChoice> {
  if (existsSync(join(options.local, 'package.json'))) {
    return { qaDir: options.local, pinned: false };
  }
  const dir = join(options.cache, `smokedesk-${options.ref}`);
  if (!(await validClone(dir, options.ref))) {
    await rm(dir, { recursive: true, force: true });
    await mkdir(options.cache, { recursive: true });
    try {
      await options.clone(SMOKEDESK_URL, dir);
      for (const { id, commit } of await publishedCommits(dir)) {
        await git(dir, 'branch', '-f', id, commit);
      }
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw new Error(
        `The e2e tests need Smoke Desk: put its qa worktree next to the desktop (../smokedesk-qa, see "Getting the Smoke Desk repository" in README.md), ` +
          `or run them once with internet access to download ${options.ref}. ${(error as Error).message}`,
        { cause: error },
      );
    }
  }
  return { qaDir: dir, pinned: true };
}

export default async function globalSetup(): Promise<void> {
  const choice = await resolveProject({
    // BUGDETECTIVE_E2E_PINNED_PROJECT=1 plays the pinned publication even with the local folder there.
    local:
      process.env.BUGDETECTIVE_E2E_PINNED_PROJECT === '1'
        ? join(root, 'test', '.cache', 'no-local-smokedesk')
        : resolve(root, '..', 'smokedesk-qa'),
    cache: join(root, 'test', '.cache'),
    ref: SMOKEDESK_QA_REF,
    clone: async (url, dir) => {
      await run('git', ['clone', '--quiet', '--branch', SMOKEDESK_QA_REF, url, dir]);
    },
  });
  await mkdir(join(root, 'test', '.cache'), { recursive: true });
  await writeFile(PROJECT_CHOICE_FILE, `${JSON.stringify(choice, null, 2)}\n`);
  console.log(
    choice.pinned ? `Smoke Desk: ${SMOKEDESK_QA_REF} (pinned, ${choice.qaDir})` : `Smoke Desk: ${choice.qaDir} (local)`,
  );
}
