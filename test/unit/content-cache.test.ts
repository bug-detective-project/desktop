import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeZip } from '@bug-detective/catalog/contract';
import { CachedContentSource, FirstDownloadError } from '../../src/main/services/content/cache.ts';
import { gitArchive } from '../../src/main/services/content/git.ts';
import { GitHubContentSource } from '../../src/main/services/content/github.ts';
import { publishProject } from '../../src/main/services/content/publish.ts';
import { runCommand } from '../../src/main/services/process.ts';
import { createProjectRepo } from '../helpers/project-repo.ts';
import type { ProjectRepo } from '../helpers/project-repo.ts';

let dir: string;
let repo: ProjectRepo;
let server: Server;
let baseUrl: string;
let requests: string[];
let offline: boolean;
let missingCommits: Set<string>;

/** A GitHub that serves the test repository as it is at each request. */
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-cache-'));
  repo = await createProjectRepo(dir, { front: 2, back: 0 });
  await publishProject({ qaDir: repo.qaDir, version: '1.0.0', runner: runCommand });
  requests = [];
  offline = false;
  missingCommits = new Set();
  const zipOf = async (ref: string) =>
    writeZip((await gitArchive(runCommand, 'git', repo.qaDir, ref)).map((file) => ({ ...file, path: `top/${file.path}` })));
  server = createServer((request, response) => {
    if (offline) {
      request.socket.destroy();
      return;
    }
    requests.push(request.url!);
    const sha = /\/archive\/([0-9a-f]{40})\.zip$/.exec(request.url!)?.[1];
    const ref = request.url === '/owner/demo/archive/refs/heads/qa.zip' ? 'qa' : sha && !missingCommits.has(sha) ? sha : null;
    if (!ref) {
      response.writeHead(404).end();
      return;
    }
    zipOf(ref).then(
      (zip) => response.writeHead(200).end(zip),
      () => response.writeHead(404).end(),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise((resolve) => server.close(resolve));
  await rm(dir, { recursive: true, force: true });
});

const cached = () =>
  new CachedContentSource(join(dir, 'cache'), new GitHubContentSource({ repository: 'owner/demo', project: 'demo', baseUrl, retries: 0 }));
const commitOf = (id: string) => repo.git(repo.qaDir, 'rev-parse', id);

/** Publishes 1.1.0 with a changed front-2. */
async function republish() {
  repo.git(repo.projectDir, 'checkout', '-q', 'front-2');
  await writeFile(join(repo.projectDir, 'app.txt'), 'bug front-2, again\n');
  repo.git(repo.projectDir, 'commit', '-q', '-am', 'Demo release front-2');
  repo.git(repo.projectDir, 'checkout', '-q', 'main');
  await publishProject({ qaDir: repo.qaDir, version: '1.1.0', runner: runCommand });
}

describe('CachedContentSource', () => {
  it('downloads the qa branch and the code of every ticket at setup', async () => {
    const source = cached();
    expect(await source.current()).toBeNull();
    const content = await source.prepare();
    expect(content.manifest.version).toBe('1.0.0');
    expect(requests).toEqual(expect.arrayContaining([`/owner/demo/archive/${commitOf('front-1')}.zip`, `/owner/demo/archive/${commitOf('front-2')}.zip`]));
    expect((await source.current())?.manifest.version).toBe('1.0.0');
  });

  it('keeps the previous cache when an update fails half way', async () => {
    const source = cached();
    await source.prepare();
    await republish();
    missingCommits.add(commitOf('front-2'));
    await expect(source.prepare()).rejects.toThrow();
    expect((await source.current())?.manifest.version).toBe('1.0.0');
  });

  it('plays from the cache without internet', async () => {
    const source = cached();
    await source.prepare();
    offline = true;
    const ticket = await source.fetchTicket('front-2');
    expect(ticket).toMatchObject({ manifestVersion: '1.0.0', entry: { id: 'front-2' } });
    expect(ticket.codeFiles.length).toBeGreaterThan(0);
  });

  it('takes a newer publication when a ticket is fetched online, downloading only the new code', async () => {
    const source = cached();
    await source.prepare();
    await republish();
    requests = [];
    const ticket = await source.fetchTicket('front-2');
    expect(ticket.manifestVersion).toBe('1.1.0');
    expect(ticket.entry.commit).toBe(commitOf('front-2'));
    expect(requests.filter((url) => /[0-9a-f]{40}\.zip$/.test(url))).toEqual([`/owner/demo/archive/${commitOf('front-2')}.zip`]);
  });

  it('asks for internet when nothing was downloaded yet', async () => {
    offline = true;
    await expect(cached().fetchTicket('front-1')).rejects.toThrow(FirstDownloadError);
    await expect(cached().prepare()).rejects.toThrow(FirstDownloadError);
  });
});
