import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packagesOf, renderNotices } from '../../tools/notices.ts';

const root = resolve(import.meta.dirname, '..', '..');

describe('third-party notices', () => {
  it('names every vendored flag with the flag-icons license', async () => {
    const notices = await readFile(join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
    expect(notices).toContain('Copyright (c) 2013 Panayiotis Lipiridis');
    expect(notices).toContain('The above copyright notice and this permission notice shall be included');
    for (const flag of await readdir(join(root, 'src', 'renderer', 'src', 'assets', 'flags'))) {
      expect(notices, `${flag} is not in THIRD_PARTY_NOTICES.md`).toContain(flag);
    }
  });

  it('is written after every build and ships with the installer', async () => {
    const scripts = (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    expect(scripts.build).toMatch(/electron-vite build && node tools\/write-notices\.ts$/);
    const builder = await readFile(join(root, 'electron-builder.yml'), 'utf8');
    expect(builder).toMatch(/- from: out\/THIRD_PARTY_NOTICES\.md\n\s+to: THIRD_PARTY_NOTICES\.md/);
  });

  it('finds the npm package of each bundled module, with its license text', () => {
    const modules = join(root, 'node_modules');
    const packages = packagesOf([
      `${modules}/react/index.js`,
      `${modules}/react/cjs/react.production.js?commonjs-exports`,
      // Windows paths, and a scoped package's asset (a font imported by CSS).
      `${modules}\\lucide-react\\dist\\esm\\lucide-react.js`,
      `${modules}/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2`,
      // The app's own code is not a third-party package.
      join(root, 'src', 'renderer', 'src', 'App.tsx'),
      '\0vite/modulepreload-polyfill',
    ]);
    expect(packages.map((item) => [item.name, item.license])).toEqual([
      ['@fontsource-variable/inter', 'OFL-1.1'],
      ['lucide-react', 'ISC'],
      ['react', 'MIT'],
    ]);
    expect(packages.find((item) => item.name === 'react')!.licenseText).toMatch(/^MIT License\s+Copyright \(c\) Meta Platforms/);
  });

  it('puts the vendored files first, then each bundled package once, sorted', () => {
    const notices = renderNotices('# Third-party notices\n\n## flag-icons\n', [
      { name: 'zwitch', version: '2.0.4', license: 'MIT', licenseText: 'Zwitch license' },
      { name: 'bail', version: '2.0.2', license: 'MIT', licenseText: 'Bail license' },
      { name: 'zwitch', version: '2.0.4', license: 'MIT', licenseText: 'Zwitch license' },
      { name: 'isarray', version: '1.0.0', license: 'MIT', licenseText: null },
    ]);
    expect(notices.indexOf('## flag-icons')).toBeLessThan(notices.indexOf('## npm packages bundled into the app'));
    expect([...notices.matchAll(/^### (.+)$/gm)].map((match) => match[1])).toEqual(['bail 2.0.2', 'isarray 1.0.0', 'zwitch 2.0.4']);
    expect(notices).toContain('The package ships no license file; its package.json declares the license "MIT".');
  });
});
