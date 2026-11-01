/**
 * Publishes a game project: validates its qa folder (a worktree of the qa branch) and ticket
 * branches, writes manifest.json, tags new ticket commits, commits on qa and records the new
 * version in content/projects.json. It never pushes; it prints the push command (see README.md,
 * "Publishing a project").
 *
 *   node tools/publish-project.ts --project supportdesk --version 2.0.1 [--dry-run]
 *   node tools/publish-project.ts --qa ../supportdesk-qa --version 2.0.1 [--dry-run]
 *
 * --project finds the qa folder in projects.local.json.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { publishProject } from '../src/main/services/content/publish.ts';
import { runCommand } from '../src/main/services/process.ts';
import { parseLocalProjects, parseProjectsCatalog } from '../src/main/services/projects.ts';

const root = resolve(import.meta.dirname, '..');
const catalogFile = join(root, 'content', 'projects.json');
const { values } = parseArgs({
  options: {
    project: { type: 'string' },
    qa: { type: 'string' },
    version: { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
  },
});
if ((!values.project && !values.qa) || !values.version) {
  console.error('Usage: pnpm run publish:project (--project <id> | --qa <qa folder>) --version <X.Y.Z> [--dry-run]');
  process.exit(2);
}

function qaFolder(): string {
  if (values.qa) {
    return resolve(values.qa);
  }
  const localFile = join(root, 'projects.local.json');
  const catalog = parseProjectsCatalog(JSON.parse(readFileSync(catalogFile, 'utf8')));
  const dirs = existsSync(localFile) ? parseLocalProjects(JSON.parse(readFileSync(localFile, 'utf8')), catalog) : {};
  const dir = dirs[values.project!];
  if (!dir) {
    console.error(`projects.local.json has no qa folder for ${values.project}; add it, or pass --qa <folder>.`);
    process.exit(2);
  }
  return resolve(root, dir);
}

const dryRun = values['dry-run']!;
const { manifest, pushCommand } = await publishProject({
  qaDir: qaFolder(),
  version: values.version,
  runner: runCommand,
  dryRun,
  catalogFile,
  log: console.log,
});
console.log(`${manifest.project.name} ${manifest.version}: ${manifest.tickets.front} front + ${manifest.tickets.back} back tickets`);
if (dryRun) {
  console.log(JSON.stringify(manifest, null, 2));
  console.log('Dry run: nothing was written (manifest.json, tags and content/projects.json are unchanged).');
} else {
  console.log(`Published locally. To publish on GitHub, run in the project folder:\n  ${pushCommand}`);
  console.log('Then commit content/projects.json in desktop/: the installed app requires at least this version.');
}
