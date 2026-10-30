/**
 * Third-party notices for the packaged app. electron-builder ships the licenses of the production
 * dependencies (they stay in node_modules), but whatever Vite bundles into the preload and the
 * renderer (React, lucide-react, the fonts, …) loses its license files. The `bundledLicenses` Vite
 * plugin records every npm package that ends up in a build (third-party-licenses.json next to it), and
 * tools/write-notices.ts merges those lists with the hand-written THIRD_PARTY_NOTICES.md (files copied
 * into the repository, such as the flag SVGs) into out/THIRD_PARTY_NOTICES.md, which the installer ships.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Plugin } from 'vite';

export const LICENSES_FILE = 'third-party-licenses.json';

export interface BundledPackage {
  name: string;
  version: string;
  /** The SPDX expression from package.json, or "UNKNOWN". */
  license: string;
  /** The package's LICENSE (or LICENCE, COPYING, NOTICE) files, or null when it ships none. */
  licenseText: string | null;
}

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.|-|$)/i;

/** The npm packages the given module ids (absolute paths, possibly with a ?query) come from. */
export function packagesOf(ids: Iterable<string>): BundledPackage[] {
  const dirs = new Set<string>();
  for (const raw of ids) {
    const id = raw.replace(/\\/g, '/').replace(/[?#].*$/, '');
    const at = id.lastIndexOf('/node_modules/');
    if (at === -1) {
      continue;
    }
    const rest = id.slice(at + '/node_modules/'.length).split('/');
    const name = rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0];
    dirs.add(`${id.slice(0, at)}/node_modules/${name}`);
  }
  const packages = new Map<string, BundledPackage>();
  for (const dir of dirs) {
    const manifest = join(dir, 'package.json');
    if (!existsSync(manifest)) {
      continue;
    }
    const json = JSON.parse(readFileSync(manifest, 'utf8')) as { name: string; version: string; license?: string | { type: string } };
    const files = readdirSync(dir).filter((file) => LICENSE_FILE.test(file)).sort();
    const text = files.map((file) => readFileSync(join(dir, file), 'utf8').trim()).join('\n\n');
    const license = typeof json.license === 'string' ? json.license : (json.license?.type ?? 'UNKNOWN');
    packages.set(`${json.name}@${json.version}`, { name: json.name, version: json.version, license, licenseText: text || null });
  }
  return [...packages.values()].sort((a, b) => (a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1));
}

/**
 * Writes third-party-licenses.json with the npm packages bundled into this build: the modules of its
 * chunks and the files its assets were made from (fonts imported by CSS, for example). Chunks the
 * installer leaves out (`skipChunks`, matched against the file name) do not count.
 */
export function bundledLicenses(options: { skipChunks?: RegExp } = {}): Plugin {
  let root = process.cwd();
  return {
    name: 'bug-detective-bundled-licenses',
    apply: 'build',
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_options, bundle) {
      const ids = new Set<string>();
      for (const output of Object.values(bundle)) {
        if (output.type === 'chunk' && !options.skipChunks?.test(output.fileName)) {
          output.moduleIds.forEach((id) => ids.add(id));
        } else if (output.type === 'asset') {
          // Relative to the build's root (src/renderer for the renderer).
          output.originalFileNames.forEach((file) => ids.add(resolve(root, file)));
        }
      }
      this.emitFile({ type: 'asset', fileName: LICENSES_FILE, source: `${JSON.stringify(packagesOf(ids), null, 2)}\n` });
    },
  };
}

/** The hand-written notices followed by one section per bundled package (each name and version once). */
export function renderNotices(handWritten: string, packages: readonly BundledPackage[]): string {
  const unique = new Map(packages.map((item) => [`${item.name}@${item.version}`, item]));
  const sections = [...unique.values()]
    .sort((a, b) => (a.name === b.name ? (a.version < b.version ? -1 : 1) : a.name < b.name ? -1 : 1))
    .map((item) => {
      const text = item.licenseText ?? `The package ships no license file; its package.json declares the license "${item.license}".`;
      return `### ${item.name} ${item.version}\n\nLicense: ${item.license}\n\n\`\`\`text\n${text}\n\`\`\`\n`;
    });
  return `${handWritten.trimEnd()}\n\n## npm packages bundled into the app\n\nThe app's code includes these packages, built into its scripts and styles.\n\n${sections.join('\n')}`;
}
