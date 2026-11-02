/**
 * Assembles the Docker build contexts in build/docker/ (packaged as app resources):
 *   workspace/  the player's workspace image (docker/workspace/)
 *   qa/         the base of the QA image (docker/qa/); the app adds the project's QA tool (cli/) at
 *               run time, from the project's downloaded qa branch
 * and writes build/docker/images.json: the workspace image tag and qaBase, the hash of qa/ that
 * the QA image tag combines with the QA tool. No game project is needed to build the app.
 *
 * It also downloads the official projects catalog to build/catalog.fallback.json (packaged as
 * resources/catalog.fallback.json): the app uses it only before its first download of the catalog
 * succeeds. Without the internet this step fails.
 *
 *   node tools/prepare-resources.ts
 */
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { parseCatalog, sha256Hex } from '@bug-detective/catalog/contract';
import { OFFICIAL_CATALOG_URL } from '../src/main/services/catalog.ts';

const root = resolve(import.meta.dirname, '..');
const out = join(root, 'build', 'docker');

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });
await cp(join(root, 'docker', 'workspace'), join(out, 'workspace'), { recursive: true });
await cp(join(root, 'docker', 'qa'), join(out, 'qa'), { recursive: true });

/** Hash of every file in a build context, so a changed Dockerfile gets a new image tag. */
async function contextHash(dir: string): Promise<string> {
  const entries = (await readdir(dir, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
  const lines: string[] = [];
  for (const file of entries) {
    lines.push(`${sha256Hex(await readFile(file))}  ${relative(dir, file).split(sep).join('/')}`);
  }
  return sha256Hex(lines.join('\n')).slice(0, 12);
}

const images = {
  workspace: `bugdetective-workspace:${await contextHash(join(out, 'workspace'))}`,
  qaBase: await contextHash(join(out, 'qa')),
  nodeVersion: (await readFile(join(root, '.nvmrc'), 'utf8')).trim(),
};
await writeFile(join(out, 'images.json'), `${JSON.stringify(images, null, 2)}\n`);
console.log(`Docker contexts written to ${out}`);
console.log(images);

const response = await fetch(OFFICIAL_CATALOG_URL, { signal: AbortSignal.timeout(30_000) }).catch((error: Error) => {
  throw new Error(`Could not download the projects catalog for the bundled fallback (${OFFICIAL_CATALOG_URL}): ${error.message}`);
});
if (!response.ok) {
  throw new Error(`Could not download the projects catalog for the bundled fallback: ${OFFICIAL_CATALOG_URL} answered ${response.status}`);
}
const catalog: unknown = await response.json();
parseCatalog(catalog);
await writeFile(join(root, 'build', 'catalog.fallback.json'), `${JSON.stringify(catalog, null, 2)}\n`);
