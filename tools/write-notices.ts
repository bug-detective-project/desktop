/**
 * Writes out/THIRD_PARTY_NOTICES.md after `electron-vite build`: the hand-written THIRD_PARTY_NOTICES.md
 * plus the licenses of every npm package bundled into main, preload and renderer (see tools/notices.ts).
 * The installer ships it next to the app.
 *
 *   node tools/write-notices.ts
 */
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { LICENSES_FILE, renderNotices } from './notices.ts';
import type { BundledPackage } from './notices.ts';

const root = resolve(import.meta.dirname, '..');
const packages: BundledPackage[] = [];
for (const target of ['main', 'preload', 'renderer']) {
  const file = join(root, 'out', target, LICENSES_FILE);
  packages.push(...(JSON.parse(await readFile(file, 'utf8')) as BundledPackage[]));
  // Merged below; the per-build lists are not shipped.
  await rm(file);
}
const notices = renderNotices(await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8'), packages);
await writeFile(join(root, 'out', 'THIRD_PARTY_NOTICES.md'), notices);
const missing = packages.filter((item) => !item.licenseText).map((item) => `${item.name}@${item.version}`);
console.log(`out/THIRD_PARTY_NOTICES.md: ${new Set(packages.map((item) => `${item.name}@${item.version}`)).size} bundled packages`);
if (missing.length > 0) {
  console.warn(`No license file shipped by: ${[...new Set(missing)].join(', ')} (their package.json license is listed instead)`);
}
