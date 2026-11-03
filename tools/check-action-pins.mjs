// Fails when a GitHub Actions workflow references an action or a reusable workflow by tag or
// branch instead of by commit hash: a moved tag would run other code in this repository.
//
//   node tools/check-action-pins.mjs [workflows directory]
//
// Local actions (./path) and docker:// references are not pinned by hash and are skipped.
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const PINNED = /^[0-9a-f]{40}$/;

/** The unpinned `uses:` references of one workflow, as "<line>: <reference>" strings. */
export function unpinnedUses(text) {
  const problems = [];
  text.split('\n').forEach((line, index) => {
    const match = /^\s*-?\s*uses:\s*["']?([^\s"'#]+)/.exec(line);
    if (!match) {
      return;
    }
    const reference = match[1];
    if (reference.startsWith('./') || reference.startsWith('docker://')) {
      return;
    }
    const at = reference.lastIndexOf('@');
    const ref = at === -1 ? '' : reference.slice(at + 1);
    if (!PINNED.test(ref)) {
      problems.push(`${index + 1}: ${reference}`);
    }
  });
  return problems;
}

export async function checkWorkflows(dir) {
  const files = (await readdir(dir)).filter((name) => /\.ya?ml$/.test(name)).sort();
  const problems = [];
  for (const name of files) {
    for (const problem of unpinnedUses(await readFile(join(dir, name), 'utf8'))) {
      problems.push(`${join(dir, name)}:${problem}`);
    }
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const dir = process.argv[2] ?? join('.github', 'workflows');
  const problems = await checkWorkflows(dir);
  if (problems.length > 0) {
    console.error('Actions must be pinned by commit hash (uses: owner/repo@<40 hex> # vX.Y.Z):');
    for (const problem of problems) {
      console.error(`  ${problem}`);
    }
    process.exit(1);
  }
  console.log('Every action is pinned by hash.');
}
