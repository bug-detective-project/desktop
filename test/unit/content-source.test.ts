import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContentVerificationError, IncompletePublicationError, TicketNotPublishedError, textFile, writeZip } from '@bug-detective/catalog/contract';
import type { ArchiveFile, ProjectManifest } from '@bug-detective/catalog/contract';
import { DownloadError, GitHubContentSource, ProjectUnavailableError, validateBaseUrl } from '../../src/main/services/content/github.ts';
import { LocalContentSource, gitArchive } from '../../src/main/services/content/local.ts';
import { publishLocally } from '../helpers/publication.ts';
import { PackageStore } from '../../src/main/services/content/store.ts';
import { runCommand } from '../../src/main/services/process.ts';
import { createProjectRepo } from '../helpers/project-repo.ts';
import type { ProjectRepo } from '../helpers/project-repo.ts';

let root: string;
let repo: ProjectRepo;
let manifest: ProjectManifest;

/** A published project with 2 front tickets and 1 back ticket. */
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'bd-content-'));
  repo = await createProjectRepo(root, { front: 2, back: 1 });
  ({ manifest } = await publishLocally(repo, '1.0.0'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('LocalContentSource', () => {
  it('reads a ticket by id, without its bug.patch', async () => {
    const ticket = await new LocalContentSource({ qaDir: repo.qaDir, runner: runCommand }).fetchTicket('back-1');
    expect(ticket.entry.id).toBe('back-1');
    expect(ticket.counts).toEqual({ front: 2, back: 1 });
    expect(ticket.packageFiles.map((file) => file.path)).toContain('reference.patch');
    expect(ticket.packageFiles.map((file) => file.path)).not.toContain('bug.patch');
    expect(ticket.codeFiles.find((file) => file.path === 'app.txt')?.data).toEqual(new TextEncoder().encode('bug back-1\n'));
  });

  it('builds the manifest from the current branches, not from a stale committed one', async () => {
    repo.git(repo.projectDir, 'checkout', '-q', 'front-1');
    await writeFile(join(repo.projectDir, 'app.txt'), 'bug front-1, rebuilt\n');
    repo.git(repo.projectDir, 'commit', '-q', '-am', 'Demo release front-1');
    repo.git(repo.projectDir, 'checkout', '-q', 'main');
    try {
      const ticket = await new LocalContentSource({ qaDir: repo.qaDir, runner: runCommand }).fetchTicket('front-1');
      expect(ticket.entry.commit).toBe(repo.git(repo.qaDir, 'rev-parse', 'front-1'));
      expect(ticket.entry.commit).not.toBe(manifest.entries[0].commit);
    } finally {
      repo.git(repo.projectDir, 'branch', '-q', '-f', 'front-1', manifest.entries[0].commit);
    }
  });

  it('reports a ticket that is not published, with the published counts', async () => {
    const error = await new LocalContentSource({ qaDir: repo.qaDir, runner: runCommand }).fetchTicket('back-2').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TicketNotPublishedError);
    expect((error as TicketNotPublishedError).counts).toEqual({ front: 2, back: 1 });
  });
});

describe('GitHubContentSource (mock server)', () => {
  let server: Server;
  let baseUrl: string;
  const requests: string[] = [];
  let failNext = 0;
  let qaFiles: ArchiveFile[];
  const codeFiles = new Map<string, ArchiveFile[]>();
  /** Per repository: how the mock GitHub serves it. */
  const variants: Record<string, { qa: () => ArchiveFile[]; code?: (files: ArchiveFile[]) => ArchiveFile[]; missingCommits?: boolean }> = {};

  beforeAll(async () => {
    qaFiles = await gitArchive(runCommand, 'git', repo.qaDir, 'qa');
    for (const entry of manifest.entries) {
      codeFiles.set(entry.commit, await gitArchive(runCommand, 'git', repo.qaDir, entry.commit));
    }
    const tamper = (files: ArchiveFile[], path: string) => files.map((file) => (file.path === path ? textFile(path, 'changed\n') : file));
    Object.assign(variants, {
      demo: { qa: () => qaFiles },
      'tampered-package': { qa: () => tamper(qaFiles, 'tickets/front-1/ticket.en.md') },
      'tampered-code': { qa: () => qaFiles, code: (files: ArchiveFile[]) => tamper(files, 'app.txt') },
      incomplete: { qa: () => qaFiles, missingCommits: true },
      'missing-file': { qa: () => qaFiles.filter((file) => file.path !== 'tickets/front-1/hints.en.json') },
    });
    // GitHub archives have one top-level folder, and redirect to codeload.
    const zipOf = (files: ArchiveFile[], top: string) => writeZip(files.map((file) => ({ ...file, path: `${top}/${file.path}` })));
    server = createServer((request, response) => {
      requests.push(request.url!);
      if (failNext > 0) {
        failNext -= 1;
        response.writeHead(503).end();
        return;
      }
      const qa = /^\/owner\/([a-z-]+)\/archive\/refs\/heads\/qa\.zip$/.exec(request.url!);
      if (qa && variants[qa[1]]) {
        response.writeHead(302, { location: `/codeload/${qa[1]}/qa.zip` }).end();
        return;
      }
      const tag = /^\/owner\/([a-z-]+)\/archive\/refs\/tags\/qa-v1\.0\.0\.zip$/.exec(request.url!);
      if (tag && variants[tag[1]]) {
        response.writeHead(200).end(zipOf(variants[tag[1]].qa(), `${tag[1]}-qa-v1.0.0`));
        return;
      }
      const codeloadQa = /^\/codeload\/([a-z-]+)\/qa\.zip$/.exec(request.url!);
      if (codeloadQa) {
        response.writeHead(200).end(zipOf(variants[codeloadQa[1]].qa(), `${codeloadQa[1]}-qa`));
        return;
      }
      const commit = /^\/owner\/([a-z-]+)\/archive\/([0-9a-f]{40})\.zip$/.exec(request.url!);
      const variant = commit && variants[commit[1]];
      if (variant && !variant.missingCommits && codeFiles.has(commit[2])) {
        const files = codeFiles.get(commit[2])!;
        response.writeHead(200).end(zipOf(variant.code ? variant.code(files) : files, `${commit[1]}-${commit[2]}`));
        return;
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const source = (repository = 'owner/demo', project = 'demo') => new GitHubContentSource({ repository, project, baseUrl, retries: 2 });

  it('downloads another qa ref, a branch or else a tag of that name', async () => {
    requests.length = 0;
    const tagged = new GitHubContentSource({ repository: 'owner/demo', project: 'demo', qaRef: 'qa-v1.0.0', baseUrl, retries: 0 });
    const ticket = await tagged.fetchTicket('front-1');
    expect(ticket.manifestVersion).toBe('1.0.0');
    expect(requests.slice(0, 2)).toEqual(['/owner/demo/archive/refs/heads/qa-v1.0.0.zip', '/owner/demo/archive/refs/tags/qa-v1.0.0.zip']);
    expect(tagged.describe()).toContain('qa-v1.0.0');
  });

  it('downloads the qa branch and the ticket commit, following redirects', async () => {
    requests.length = 0;
    const ticket = await source().fetchTicket('back-1');
    expect(ticket).toMatchObject({ counts: { front: 2, back: 1 }, manifestVersion: '1.0.0', entry: { id: 'back-1' } });
    expect(ticket.packageFiles.map((file) => file.path)).not.toContain('bug.patch');
    expect(ticket.codeFiles.map((file) => file.path).sort()).toEqual(['app.txt', 'package.json']);
    expect(requests).toEqual([
      '/owner/demo/archive/refs/heads/qa.zip',
      '/codeload/demo/qa.zip',
      `/owner/demo/archive/${manifest.entries[2].commit}.zip`,
    ]);
  });

  it('reports a ticket that is not published, with the published counts', async () => {
    const error = await source().fetchTicket('front-3').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TicketNotPublishedError);
    expect((error as TicketNotPublishedError).counts).toEqual({ front: 2, back: 1 });
  });

  it('rejects a package that does not match the manifest', async () => {
    await expect(source('owner/tampered-package').fetchTicket('front-1')).rejects.toThrow(/package/);
  });

  it('rejects ticket code that does not match the manifest', async () => {
    await expect(source('owner/tampered-code').fetchTicket('front-1')).rejects.toThrow(/code/);
  });

  it('rejects a package with a missing file', async () => {
    await expect(source('owner/missing-file').fetchTicket('front-1')).rejects.toThrow(ContentVerificationError);
  });

  it('reports a ticket commit that GitHub does not have as an incomplete publication', async () => {
    await expect(source('owner/incomplete').fetchTicket('front-1')).rejects.toThrow(IncompletePublicationError);
  });

  it('treats a manifest older than the version in projects.json as an incomplete publication', async () => {
    const stale = new GitHubContentSource({ repository: 'owner/demo', project: 'demo', baseUrl, retries: 0, minVersion: '1.1.0' });
    await expect(stale.fetchTicket('front-1')).rejects.toThrow(IncompletePublicationError);
    const current = new GitHubContentSource({ repository: 'owner/demo', project: 'demo', baseUrl, retries: 0, minVersion: '1.0.0' });
    await expect(current.fetchTicket('front-1')).resolves.toBeDefined();
  });

  it('rejects the manifest of another project', async () => {
    await expect(source('owner/demo', 'other').fetchTicket('front-1')).rejects.toThrow(/another project/);
  });

  it('retries server errors', async () => {
    failNext = 2;
    await expect(source().fetchTicket('front-1')).resolves.toBeDefined();
  });

  it('fetches a given publication by its tag, without the version floor, and refuses a tag that publishes another version', async () => {
    requests.length = 0;
    const floored = new GitHubContentSource({ repository: 'owner/demo', project: 'demo', baseUrl, retries: 0, minVersion: '9.0.0' });
    await expect(floored.prepare()).rejects.toThrow(/older than 9.0.0/);
    const content = await floored.publication('1.0.0');
    expect(content.manifest.version).toBe('1.0.0');
    expect(requests.filter((url) => url.includes('qa-v1.0.0'))).toEqual(['/owner/demo/archive/refs/heads/qa-v1.0.0.zip', '/owner/demo/archive/refs/tags/qa-v1.0.0.zip']);
    // The code of an entry, verified.
    const entry = content.manifest.entries[0];
    expect((await floored.codeOf(entry)).length).toBe(entry.codeFiles);
    // A publication that is not there.
    await expect(floored.publication('1.0.1')).rejects.toThrow(ProjectUnavailableError);
    expect(GitHubContentSource.publicationTag('1.2.3')).toBe('qa-v1.2.3');
  });

  it('gives up after the retries', async () => {
    failNext = 10;
    await expect(source().fetchTicket('front-1')).rejects.toThrow(DownloadError);
    failNext = 0;
  });

  it('reports a missing repository', async () => {
    await expect(source('owner/missing').fetchTicket('front-1')).rejects.toThrow(ProjectUnavailableError);
    await expect(source('owner/missing').fetchTicket('front-1')).rejects.toThrow(/has no qa branch or tag/);
  });

  it('accepts only https, or http on loopback', () => {
    expect(() => validateBaseUrl('http://example.com')).toThrow();
    expect(() => validateBaseUrl('https://user:pw@github.com')).toThrow();
    expect(validateBaseUrl('https://github.com').hostname).toBe('github.com');
    expect(() => new GitHubContentSource({ repository: '../etc', project: 'demo' })).toThrow();
    expect(() => new GitHubContentSource({ repository: 'a/b', project: 'Not An Id' })).toThrow();
  });

  it('enforces a size limit', async () => {
    const small = new GitHubContentSource({ repository: 'owner/demo', project: 'demo', baseUrl, maxBytes: 100, retries: 0 });
    await expect(small.fetchTicket('front-1')).rejects.toThrow(/larger than/);
  });
});

describe('PackageStore', () => {
  it('stores the zip and an extracted folder, replacing an older copy atomically', async () => {
    const store = new PackageStore(join(root, 'João Silva', 'packages'));
    const zip = writeZip([textFile('ticket.en.md', '# SD-214: Details\n')]);
    expect(store.has(1)).toBe(false);
    await store.save(1, zip);
    await store.save(1, zip);
    expect(store.has(1)).toBe(true);
    expect(await store.readText(1, 'ticket.en.md')).toBe('# SD-214: Details\n');
    expect(await store.readText(1, 'missing.md')).toBeNull();
    expect(Buffer.compare(await store.readZip(1), zip)).toBe(0);
    expect(await readFile(join(store.dir(1), 'ticket.en.md'), 'utf8')).toBe('# SD-214: Details\n');
  });
});
