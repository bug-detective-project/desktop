import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CatalogService, OFFICIAL_CATALOG_URL, chooseCatalogSource, parseLocalCatalog, readLocalCatalogFile, writeLocalCatalogFile } from '../../src/main/services/catalog.ts';

const project = (id: string, extra: Record<string, unknown> = {}) => ({ id, repository: `bug-detective-project/${id}`, ...extra });
const catalogJson = (...projects: unknown[]) => JSON.stringify({ projects });

describe('chooseCatalogSource', () => {
  const base = { packaged: false, env: {}, localCatalog: null, baseDir: '/desktop' };

  it('always uses the official catalog in the installed app', () => {
    expect(chooseCatalogSource({ ...base, packaged: true, env: { BUGDETECTIVE_CATALOG_FILE: '/x.json' }, localCatalog: { catalog: { file: 'y.json' } } })).toEqual({ kind: 'official' });
  });

  it('uses the official catalog in development without settings', () => {
    expect(chooseCatalogSource(base)).toEqual({ kind: 'official' });
  });

  it('uses the test variable first, then catalog.local.json', () => {
    expect(chooseCatalogSource({ ...base, env: { BUGDETECTIVE_CATALOG_FILE: '/tmp/c.json' }, localCatalog: { catalog: { file: 'y.json' } } })).toEqual({ kind: 'file', path: '/tmp/c.json' });
    expect(chooseCatalogSource({ ...base, localCatalog: { catalog: { file: '../catalog/projects.json' } } })).toEqual({ kind: 'file', path: '/catalog/projects.json' });
    expect(chooseCatalogSource({ ...base, localCatalog: { catalog: { github: 'me/catalog', branch: 'testar-x' } } })).toEqual({ kind: 'github', repository: 'me/catalog', branch: 'testar-x' });
  });
});

describe('parseLocalCatalog', () => {
  it('accepts a catalog source and per-project overrides', () => {
    const parsed = parseLocalCatalog({ catalog: { github: 'bug-detective-project/catalog' }, projects: { supportdesk: { qaDir: '../supportdesk-qa' }, other: { qaRef: 'qa-next' } } });
    expect(parsed.catalog).toEqual({ github: 'bug-detective-project/catalog', branch: 'main' });
    expect(parsed.projects?.other).toEqual({ qaRef: 'qa-next' });
  });

  it.each([
    ['a project with both qaDir and qaRef', { projects: { a: { qaDir: 'x', qaRef: 'y' } } }],
    ['a catalog with neither github nor file', { catalog: { url: 'x' } }],
    ['an unknown field', { catalogs: {} }],
  ])('refuses %s, naming the file', (_name, raw) => {
    expect(() => parseLocalCatalog(raw)).toThrow(/Invalid catalog\.local\.json/);
  });
});

describe('catalog.local.json file', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bugdetective-local-catalog-'));
    file = join(dir, 'catalog.local.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads a missing file as the default settings', async () => {
    expect(await readLocalCatalogFile(file)).toEqual({ settings: {}, error: null });
  });

  it.each([
    ['broken JSON', '{'],
    ['an unknown field', JSON.stringify({ catalogs: {} })],
  ])('reads a file with %s as the default settings, with the reason', async (_name, text) => {
    await writeFile(file, text);
    const read = await readLocalCatalogFile(file);
    expect(read.settings).toEqual({});
    expect(read.error).toMatch(/Invalid catalog\.local\.json|JSON/);
  });

  it('writes the settings and reads them back', async () => {
    const settings = { catalog: { github: 'me/catalog', branch: 'x' }, projects: { supportdesk: { qaRef: 'qa-next' } } };
    await writeLocalCatalogFile(file, settings);
    expect(await readLocalCatalogFile(file)).toEqual({ settings, error: null });
    expect(await readFile(file, 'utf8')).toMatch(/\n$/);
  });

  it('deletes the file for the default settings', async () => {
    await writeLocalCatalogFile(file, { projects: { supportdesk: { qaRef: 'qa-next' } } });
    await writeLocalCatalogFile(file, {});
    expect(existsSync(file)).toBe(false);
    await writeLocalCatalogFile(file, { projects: { supportdesk: { qaRef: 'qa-next' } } });
    await writeLocalCatalogFile(file, { projects: {} });
    expect(existsSync(file)).toBe(false);
  });

  it('refuses invalid settings and keeps the file', async () => {
    await writeLocalCatalogFile(file, { projects: { gone: { qaDir: '../gone-qa' } } });
    await expect(writeLocalCatalogFile(file, { projects: { a: { qaDir: 'x', qaRef: 'y' } } } as never)).rejects.toThrow(/Invalid catalog\.local\.json/);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ projects: { gone: { qaDir: '../gone-qa' } } });
  });
});

describe('CatalogService', () => {
  let dir: string;
  let cacheFile: string;
  let fallbackFile: string;
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'bugdetective-catalog-'));
    cacheFile = join(dir, 'catalog.json');
    fallbackFile = join(dir, 'catalog.fallback.json');
    await writeFile(fallbackFile, catalogJson(project('supportdesk', { starter: true })));
    lines.length = 0;
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const service = (fetchText: (url: string) => Promise<string>, extra: Partial<ConstructorParameters<typeof CatalogService>[0]> = {}) =>
    new CatalogService({ choice: { kind: 'official' }, overrides: {}, baseDir: dir, cacheFile, fallbackFile, fetchText, log, ...extra });

  it('uses the bundled fallback before the first download', async () => {
    const projects = await service(async () => { throw new Error('offline'); }).current();
    expect(projects.map((item) => [item.id, item.starter, item.official])).toEqual([['supportdesk', true, true]]);
  });

  it('downloads the official catalog, caches it and uses it from then on', async () => {
    const urls: string[] = [];
    const catalog = service(async (url) => {
      urls.push(url);
      return catalogJson(project('supportdesk', { starter: true }), project('tasklist', { hidden: true }));
    });
    await catalog.refresh();
    expect(urls).toEqual([OFFICIAL_CATALOG_URL]);
    expect((await catalog.current()).map((item) => item.id)).toEqual(['supportdesk', 'tasklist']);
    expect(JSON.parse(await readFile(cacheFile, 'utf8')).source).toBe('official');
  });

  it('keeps the cache when the download fails or the catalog is invalid', async () => {
    await service(async () => catalogJson(project('supportdesk', { starter: true }), project('tasklist'))).refresh();
    await service(async () => { throw new Error('offline'); }).refresh();
    await service(async () => catalogJson(project('supportdesk', { starter: true, hidden: true }))).refresh();
    await service(async () => 'not json').refresh();
    expect((await service(async () => '').current()).map((item) => item.id)).toEqual(['supportdesk', 'tasklist']);
    expect(lines.join('\n')).toMatch(/offline/);
    expect(lines.join('\n')).toMatch(/starter cannot be hidden/);
  });

  it('applies a qaDir or qaRef override, which makes the project unofficial', async () => {
    await writeFile(cacheFile, JSON.stringify({ source: 'official', fetchedAt: 'x', catalog: { projects: [project('supportdesk', { starter: true }), project('tasklist')] } }));
    const projects = await service(async () => '', { overrides: { supportdesk: { qaDir: 'supportdesk-qa' }, tasklist: { qaRef: 'qa-next' } } }).current();
    expect(projects[0]).toMatchObject({ id: 'supportdesk', qaDir: join(dir, 'supportdesk-qa'), official: false });
    expect(projects[1]).toMatchObject({ id: 'tasklist', qaRef: 'qa-next', official: false });
  });

  it('reads a file catalog, whose projects may be local folders, and never treats it as official', async () => {
    const file = join(dir, 'projects.json');
    await writeFile(file, JSON.stringify({ projects: [{ id: 'supportdesk', qaDir: 'supportdesk-qa', starter: true }, project('tasklist')] }));
    const catalog = service(async () => { throw new Error('no network for a file'); }, { choice: { kind: 'file', path: file } });
    await catalog.refresh();
    const projects = await catalog.current();
    expect(projects[0]).toMatchObject({ id: 'supportdesk', qaDir: join(dir, 'supportdesk-qa'), official: false });
    expect(projects[1]).toMatchObject({ id: 'tasklist', official: false });
  });

  it('reads a file catalog on the first start, before any refresh, instead of the bundled fallback', async () => {
    const file = join(dir, 'projects.json');
    await writeFile(file, JSON.stringify({ projects: [{ id: 'supportdesk', qaDir: 'supportdesk-qa', starter: true }] }));
    const projects = await service(async () => { throw new Error('no network for a file'); }, { choice: { kind: 'file', path: file } }).current();
    expect(projects[0]).toMatchObject({ id: 'supportdesk', qaDir: join(dir, 'supportdesk-qa'), official: false });
  });

  it('downloads another branch of a catalog repository, never official', async () => {
    const urls: string[] = [];
    const catalog = service(async (url) => { urls.push(url); return catalogJson(project('supportdesk', { starter: true })); }, { choice: { kind: 'github', repository: 'me/catalog', branch: 'testar-x' } });
    await catalog.refresh();
    expect(urls).toEqual(['https://raw.githubusercontent.com/me/catalog/testar-x/projects.json']);
    expect((await catalog.current())[0].official).toBe(false);
  });

  it('reconfigure switches the source and the overrides', async () => {
    await writeFile(cacheFile, JSON.stringify({ source: 'official', fetchedAt: 'x', catalog: { projects: [project('supportdesk', { starter: true }), project('tasklist')] } }));
    const file = join(dir, 'projects.json');
    await writeFile(file, catalogJson(project('supportdesk', { starter: true })));
    const catalog = service(async () => { throw new Error('offline'); });
    catalog.reconfigure({ kind: 'file', path: file }, { supportdesk: { qaRef: 'qa-next' } });
    expect(catalog.describe()).toBe(`file ${file}`);
    expect(await catalog.current()).toEqual([expect.objectContaining({ id: 'supportdesk', qaRef: 'qa-next', official: false })]);
    catalog.reconfigure({ kind: 'official' }, {});
    await catalog.refresh();
    // The file's catalog replaced the cache, so back on the official source without a download: the bundled fallback.
    expect((await catalog.current()).map((item) => [item.id, item.official])).toEqual([['supportdesk', true]]);
  });

  it('does not reuse a cache downloaded from another source', async () => {
    await writeFile(cacheFile, JSON.stringify({ source: 'github me/catalog@testar-x', fetchedAt: 'x', catalog: { projects: [project('other', { starter: true })] } }));
    expect((await service(async () => '').current()).map((item) => item.id)).toEqual(['supportdesk']);
  });
});
