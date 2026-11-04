import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRuntime } from '../../src/main/fake-runtime.ts';
import { Game } from '../../src/main/game.ts';
import type { DevCatalogOptions, GameOptions } from '../../src/main/game.ts';
import type { GameRuntime } from '../../src/main/runtime.ts';
import { LocalContentSource } from '../../src/main/services/content/local.ts';
import { FirstDownloadError } from '../../src/main/services/content/cache.ts';
import type { LocalCatalog, ResolvedProject } from '../../src/main/services/catalog.ts';
import type { ContentSource, ProjectContent } from '../../src/main/services/content/source.ts';
import { IncompletePublicationError, TicketNotPublishedError, UnsupportedFormatError, readZip } from '@bug-detective/catalog/contract';
import type { ArchiveFile } from '@bug-detective/catalog/contract';
import { PackageStore } from '../../src/main/services/content/store.ts';
import { runCommand } from '../../src/main/services/process.ts';
import { ReviewStore } from '../../src/main/services/review/store.ts';
import { StateStore } from '../../src/main/services/state.ts';
import * as rules from '../../src/shared/kanban.ts';
import { backupStatus } from '../../src/shared/types.ts';
import { createNotesProject } from '../helpers/notes-project.ts';
import { unlocked } from '../helpers/tickets.ts';
import { createProjectRepo } from '../helpers/project-repo.ts';
import type { ProjectBrief } from '../helpers/project-repo.ts';

// The notes example project (test/fixtures/notes) laid out like a published project, once per file:
// two front tickets and one back ticket, three hints each.
let notesDir: string;
let notesQaDir: string;
beforeAll(async () => {
  notesDir = await mkdtemp(join(tmpdir(), 'bd-game-notes-'));
  notesQaDir = (await createNotesProject(notesDir)).qaDir;
});
afterAll(async () => {
  await rm(notesDir, { recursive: true, force: true });
});
const localSource = () => new LocalContentSource({ qaDir: notesQaDir, runner: runCommand });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-game-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function createGame(
  options: {
    scenario?: object;
    content?: ContentSource;
    devSolveBug?: boolean;
    devSkipOnboarding?: boolean;
    devShowProjects?: boolean;
    autoOnboarding?: boolean;
    diagnostics?: GameOptions['diagnostics'];
    clock?: () => Date;
    installKey?: Uint8Array;
  } = {},
) {
  const runtime = new FakeRuntime(JSON.stringify({ qaDelayMs: 1, ...options.scenario }));
  const game = new Game({
    store: new StateStore(dir),
    packages: new PackageStore(join(dir, 'packages')),
    reviews: new ReviewStore(join(dir, 'reviews')),
    content: options.content ?? localSource(),
    runtime,
    appVersion: '0.1.0',
    versions: { electron: 'test', node: process.versions.node, chrome: 'test' },
    devSolveBug: options.devSolveBug,
    devSkipOnboarding: options.devSkipOnboarding,
    devShowProjects: options.devShowProjects,
    autoOnboarding: options.autoOnboarding,
    diagnostics: options.diagnostics,
    clock: options.clock,
    installKey: options.installKey,
  });
  return { game, runtime };
}

const status = (game: Game, ticket = 1) => rules.findTicket(game.current, ticket)!.status;

describe('QA and the computer', () => {
  it('finishes a run whose wall clock jumped two hours (sleep): the time limit is not the clock', async () => {
    let now = new Date('2026-11-04T10:00:00.000Z');
    const { game } = createGame({ scenario: { qa: ['passed'], qaDelayMs: 50 }, clock: () => now });
    await game.init();
    await game.nextAssignment();
    await game.move(1, 'inProgress');
    const run = game.move(1, 'inQa');
    now = new Date('2026-11-04T12:00:00.000Z');
    await run;
    await game.waitForQa();
    expect(status(game)).toBe('codeReview');
    expect(rules.findTicket(game.current, 1)!.attempts).toHaveLength(1);
  });

  it('suspend() during a run kills it and records it as interrupted, with no attempt spent', async () => {
    const { game, runtime } = createGame({ scenario: { qa: ['passed'], qaDelayMs: 5000 } });
    await game.init();
    await game.nextAssignment();
    await game.move(1, 'inProgress');
    await game.move(1, 'inQa');
    expect(status(game)).toBe('inQa');

    await game.suspend();
    expect(runtime.abortCalls).toBe(1);
    const ticket = rules.findTicket(game.current, 1)!;
    expect(ticket.status).toBe('inProgress');
    expect(ticket.attempts).toEqual([]);
    expect(ticket.comments.at(-1)?.kind).toBe('interrupted');
    expect(game.snapshot().log.join('\n')).toContain('going to sleep');

    // Nothing to do without a run; the next run works as usual.
    await game.suspend();
    expect(runtime.abortCalls).toBe(1);
    await game.move(1, 'inQa');
    await game.waitForQa();
    expect(status(game)).toBe('codeReview');
  });
});

describe('a restored save', () => {
  it('points the last export at the file just restored, dated when the save was made', async () => {
    // Before any ticket: the fake runtime has no repository to bundle, and a save with progress needs one.
    const { game } = createGame();
    await game.init();
    const file = join(dir, 'bug-detective-2026-11-04.bdsave');
    await game.exportProgress(file);
    const at = game.current.lastExport!.at;

    const restored = join(dir, 'from-another-computer.bdsave');
    const { copyFile } = await import('node:fs/promises');
    await copyFile(file, restored);
    const { token } = await game.inspectSave(restored, 'from-another-computer.bdsave');
    await game.restoreProgress(token);
    expect(game.current.lastExport).toEqual({ at, path: restored });
  });
});

describe('a restored save is checked against the publication', () => {
  /** Rewrites one entry of a save and signs the manifest again with the given key (what a forged save would do). */
  async function reforge(file: string, key: Uint8Array, change: (files: ArchiveFile[]) => ArchiveFile[]): Promise<string> {
    const { readFile: read, writeFile: write } = await import('node:fs/promises');
    const { signManifest } = await import('../../src/main/services/backup.ts');
    const { readZip, sha256Hex, textFile, writeZip } = await import('@bug-detective/catalog/contract');
    const files = change(readZip(new Uint8Array(await read(file))).filter((item) => item.path !== 'manifest.json'));
    const original = JSON.parse(Buffer.from(readZip(new Uint8Array(await read(file))).find((item) => item.path === 'manifest.json')!.data).toString()) as Record<string, unknown>;
    const unsigned: Record<string, unknown> = { ...original, files: Object.fromEntries(files.map((item) => [item.path, sha256Hex(item.data)])) };
    delete unsigned.hmac;
    const manifest = { ...unsigned, hmac: signManifest(unsigned as never, key) };
    const forged = join(dirname(file), `forged-${basename(file)}`);
    await write(forged, writeZip([...files, textFile('manifest.json', JSON.stringify(manifest))]));
    return forged;
  }

  it('refuses a save whose ticket package was changed, before touching anything', async () => {
    const { game, runtime } = createGame();
    vi.spyOn(runtime as GameRuntime, 'bundle').mockResolvedValue(new Uint8Array(Buffer.from('# v2 git bundle\n')));
    await game.init();
    await game.nextAssignment();
    const file = join(dir, 'progress.bdsave');
    await game.exportProgress(file);
    const { readZip, textFile, writeZip } = await import('@bug-detective/catalog/contract');
    const forged = await reforge(file, new Uint8Array(32), (files) =>
      files.map((item) => {
        if (item.path !== 'packages/stage-1.zip') return item;
        const inside = readZip(item.data).map((entry) => (entry.path === 'reference.patch' ? textFile('reference.patch', 'anything\n') : entry));
        return { ...item, data: writeZip(inside) };
      }),
    );
    const restore = vi.spyOn(runtime, 'restoreWorkspace');
    const before = game.current;
    const { token, summary } = await game.inspectSave(forged, 'forged.bdsave');
    expect(summary.fromThisInstall).toBe(true);
    await expect(game.restoreProgress(token)).rejects.toMatchObject({ code: 'saveTampered', message: expect.stringContaining('front-1') });
    expect(restore).not.toHaveBeenCalled();
    expect(game.current).toEqual(before);
    expect(game.snapshot().busy).toBeNull();
  });

  it('tells a save made by another installation apart, and imports the stages again from the verified code', async () => {
    const { game, runtime } = createGame({ installKey: new Uint8Array(Buffer.from('11'.repeat(32), 'hex')) });
    vi.spyOn(runtime as GameRuntime, 'bundle').mockResolvedValue(new Uint8Array(Buffer.from('# v2 git bundle\n')));
    await game.init();
    await game.nextAssignment();
    const file = join(dir, 'progress.bdsave');
    await game.exportProgress(file);
    expect((await game.inspectSave(file, 'progress.bdsave')).summary.fromThisInstall).toBe(true);

    // The same file, signed by another installation's key.
    const foreign = await reforge(file, new Uint8Array(Buffer.from('22'.repeat(32), 'hex')), (files) => files);
    const { token, summary } = await game.inspectSave(foreign, 'foreign.bdsave');
    expect(summary.fromThisInstall).toBe(false);
    const importStage = vi.spyOn(runtime, 'importStage');
    await game.restoreProgress(token);
    expect(importStage).toHaveBeenCalledTimes(1);
    expect(importStage.mock.calls[0][0]).toBe(1);
    expect(game.snapshot().log.join('\n')).toContain('» Verified the code of ticket 1 (front-1)');
    expect(rules.findTicket(game.current, 1)!.stageCommit).toBe(await importStage.mock.results[0].value);
  });

  it('needs the internet when the publication to check against is neither cached nor reachable', async () => {
    const offline: ContentSource = {
      ...localSource(),
      kind: 'github',
      describe: () => 'mock',
      prepare: () => localSource().prepare(),
      current: () => localSource().current(),
      fetchTicket: (id) => localSource().fetchTicket(id),
      codeOf: (entry) => localSource().codeOf(entry),
      publication: () => Promise.reject(new FirstDownloadError('offline')),
    };
    const { game, runtime } = createGame({ content: offline });
    vi.spyOn(runtime as GameRuntime, 'bundle').mockResolvedValue(new Uint8Array(Buffer.from('# v2 git bundle\n')));
    await game.init();
    await game.nextAssignment();
    const file = join(dir, 'progress.bdsave');
    await game.exportProgress(file);
    const restore = vi.spyOn(runtime, 'restoreWorkspace');
    const { token } = await game.inspectSave(file, 'progress.bdsave');
    await expect(game.restoreProgress(token)).rejects.toMatchObject({ code: 'contentNeedsInternet' });
    expect(restore).not.toHaveBeenCalled();
  });
});

describe("the workspace's internet", () => {
  it('opens when asked, shows in the snapshot, and closes on the next ticket', async () => {
    const { game, runtime } = createGame({ scenario: { qa: ['passed'] } });
    await game.init();
    await game.nextAssignment();
    expect(game.snapshot().workspaceInternet).toBe(false);
    await game.setWorkspaceInternet(true);
    expect(game.snapshot().workspaceInternet).toBe(true);
    expect(game.snapshot().log.join('\n')).toContain('can reach the internet');

    await game.move(1, 'inProgress');
    await game.move(1, 'inQa');
    await game.waitForQa();
    await game.acceptReview(1);
    await game.nextAssignment();
    expect(game.snapshot().workspaceInternet).toBe(false);
    expect(runtime.internetChanges).toEqual([true, false]);
  });

  it('closes what a crash left open, follows what Docker says, and is refused while the code is lost', async () => {
    const { game, runtime } = createGame();
    await game.init();
    await game.nextAssignment();
    await runtime.setWorkspaceInternet(true);
    await game.refreshEnvironment();
    expect(game.snapshot().workspaceInternet).toBe(true);
    await game.cleanupLeftovers();
    expect(game.snapshot().workspaceInternet).toBe(false);
    expect(await runtime.workspaceInternet()).toBe(false);

    await runtime.setWorkspaceInternet(true);
    runtime.simulate({ workspaceLost: true });
    await game.refreshEnvironment();
    await expect(game.setWorkspaceInternet(true)).rejects.toMatchObject({ code: 'workspaceLost' });
    await game.rebuildWorkspace();
    expect(game.snapshot().workspaceInternet).toBe(false);
    expect(await runtime.workspaceInternet()).toBe(false);
  });

  it('is closed when the app quits', async () => {
    const { game, runtime } = createGame();
    await game.init();
    await game.nextAssignment();
    await game.setWorkspaceInternet(true);
    await game.shutdown();
    expect(await runtime.workspaceInternet()).toBe(false);
  });
});

describe('a failed database reset', () => {
  it('is logged and shown, never stops the ticket, and clears with a retry that succeeds', async () => {
    const { game, runtime } = createGame({ scenario: { dbResetFails: true } });
    await game.init();
    await game.nextAssignment();
    expect(game.snapshot().dbResetFailed).toBe(true);
    expect(game.snapshot().log.join('\n')).toContain('» npm run db:reset failed: npm run db:reset exited with code 1 (fake)');
    expect(status(game)).toBe('todo');
    await game.move(1, 'inProgress');
    expect(status(game)).toBe('inProgress');

    await expect(game.retryDatabaseReset()).rejects.toMatchObject({ code: 'dbResetFailed' });
    runtime.simulate({ dbResetFails: false });
    await game.retryDatabaseReset();
    expect(game.snapshot().dbResetFailed).toBe(false);
    expect(game.snapshot().log.join('\n')).toContain('» npm run db:reset succeeded');
  });
});

describe('disk space before the environment download', () => {
  it('refuses the download under 10 GiB free with the free bytes, unless the player continues anyway', async () => {
    const { game, runtime } = createGame({ scenario: { environmentReady: false, freeDiskBytes: 1_000_000_000 } });
    await game.init();
    await game.contentLoaded();
    await expect(game.installEnvironment()).rejects.toMatchObject({ code: 'lowDiskSpace', message: '1000000000' });
    expect((await runtime.environment()).ready).toBe(false);
    expect(game.snapshot().log.join('\n')).toContain('» 1.0 GB free on the Docker disk; about 10 GB are needed');

    await game.installEnvironment({ ignoreDiskSpace: true });
    expect((await runtime.environment()).ready).toBe(true);
  });

  it('downloads when the space is enough or cannot be measured', async () => {
    const enough = createGame({ scenario: { environmentReady: false, freeDiskBytes: 10 * 1024 ** 3 } });
    await enough.game.init();
    await enough.game.contentLoaded();
    await enough.game.installEnvironment();
    expect((await enough.runtime.environment()).ready).toBe(true);

    const unknown = createGame({ scenario: { environmentReady: false, freeDiskBytes: null } });
    await unknown.game.init();
    await unknown.game.contentLoaded();
    await unknown.game.installEnvironment();
    expect((await unknown.runtime.environment()).ready).toBe(true);
  });
});

describe('diagnostics', () => {
  it('describes the versions, the project and the recent log, and keeps the home folder out', async () => {
    const { game } = createGame();
    await game.init();
    await game.nextAssignment();
    const text = await game.diagnostics();
    expect(text).toContain('app: 0.1.0');
    expect(text).toContain('project: Notes (notes)');
    expect(text).toMatch(/## Log \(last \d+ lines\)/);
    expect(text).toContain('» Fetching front-1');
  });

  it('reports why the logs folder could not be opened, under its own code', async () => {
    const { game } = createGame({
      diagnostics: {
        os: { platform: 'linux', release: '', version: '', arch: 'x64' },
        home: '/home/dev',
        recentLog: async () => [],
        openLogsFolder: async () => {
          throw new Error('No file manager is installed');
        },
      },
    });
    await expect(game.openLogsFolder()).rejects.toMatchObject({ code: 'logsFolderFailed', message: 'No file manager is installed' });
  });
});

describe('a workspace whose volume went', () => {
  it('comes back from a save: the restore is the way out, not an action the lost workspace refuses', async () => {
    const { game, runtime } = createGame();
    vi.spyOn(runtime as GameRuntime, 'bundle').mockResolvedValue(new Uint8Array(Buffer.from('# v2 git bundle\n')));
    await game.init();
    await game.nextAssignment();
    await game.move(1, 'inProgress');
    const file = join(dir, 'progress.bdsave');
    await game.exportProgress(file);

    runtime.simulate({ workspaceLost: true });
    await game.refreshEnvironment();
    expect(game.snapshot().workspaceLost).toBe(true);

    const { token } = await game.inspectSave(file, 'progress.bdsave');
    await game.restoreProgress(token);
    expect(game.snapshot().workspaceLost).toBe(false);
    expect(game.current.currentTicket).toBe(1);
    expect(await runtime.hasRepository()).toBe(true);
  });

  it('is noticed by the environment check, blocks the code actions, and is recreated ticket by ticket', async () => {
    const { game, runtime } = createGame();
    await game.init();
    await game.nextAssignment();
    await game.move(1, 'inProgress');
    expect(game.snapshot().workspaceLost).toBe(false);

    runtime.simulate({ workspaceLost: true });
    expect(await runtime.hasRepository()).toBe(false);
    await game.refreshEnvironment();
    expect(game.snapshot().workspaceLost).toBe(true);
    await expect(game.move(1, 'inQa')).rejects.toMatchObject({ code: 'workspaceLost' });
    await expect(game.openVSCode()).rejects.toMatchObject({ code: 'workspaceLost' });
    await expect(game.startDevServer()).rejects.toMatchObject({ code: 'workspaceLost' });
    await expect(game.nextAssignment()).rejects.toMatchObject({ code: 'ticketNotDone' });

    await game.rebuildWorkspace();
    expect(game.snapshot().workspaceLost).toBe(false);
    expect(await runtime.hasRepository()).toBe(true);
    expect(await runtime.currentBranch()).toBe('player/ticket-1');
    expect(game.snapshot().log.join('\n')).toMatch(/Recreated the code of ticket 1 \(front-1\)/);
    expect(status(game)).toBe('inProgress');
    await game.openVSCode();
  });

  it('is never reported before any ticket was unlocked', async () => {
    const { game, runtime } = createGame();
    await game.init();
    runtime.simulate({ workspaceLost: true });
    await game.refreshEnvironment();
    expect(game.snapshot().workspaceLost).toBe(false);
  });
});

describe('Game', () => {
  it('unlocks stage 1 from the local source and stores its package', async () => {
    const { game } = createGame();
    await game.init();
    await game.nextAssignment();
    expect(game.current.currentTicket).toBe(1);
    expect(game.current.tracks).toEqual({ front: 2, back: 1 });
    expect(rules.findTicket(game.current, 1)).toMatchObject({ id: 'front-1', track: 'front', manifestVersion: '0.0.0' });
    expect(status(game)).toBe('todo');
    expect(game.snapshot().titles[1].en).toBe('An empty title shows nothing');
    expect(game.snapshot().titles[1].pt).toBe('Um título vazio não mostra nada');
    expect(game.snapshot().hintsTotal[1]).toBe(3);
    const content = await game.ticketContent(1, 'en');
    expect(content.ticketMarkdown).toContain('Untitled');
    expect(content.hints).toEqual([]);
    expect(content.solutionMarkdown).toBeNull();
    expect(content.reviewMarkdown).toBeNull();
    expect(content.referencePatch).toBeNull();
  });

  it('keeps both changes when two of them overlap, in memory and on disk', async () => {
    const { game } = createGame();
    await game.init();
    const welcome = game.current.inbox[0].id;
    // Neither call waits for the other: the second must start from the state the first left.
    await Promise.all([game.updateSettings({ theme: 'dark' }), game.markInboxRead(welcome)]);
    expect(game.current.settings.theme).toBe('dark');
    expect(game.current.inbox[0].read).toBe(true);
    const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')) as typeof game.current;
    expect(saved.settings.theme).toBe('dark');
    expect(saved.inbox[0].read).toBe(true);
    // A change refused by the rules does not block the ones after it.
    await expect(game.askSenior(1)).rejects.toMatchObject({ code: 'noSuchTicket' });
    await game.updateSettings({ theme: 'light' });
    expect(game.current.settings.theme).toBe('light');
  });

  it('reads the project content at start: the story, and the QA tool without the tickets', async () => {
    const { game, runtime } = createGame();
    const setQaTool = vi.spyOn(runtime, 'setQaTool');
    await game.init();
    expect(game.snapshot().projectStory?.en.project.name).toBe('Notes');
    expect(game.snapshot().projectStory?.pt.messages.assignments['front-1'].subject).toMatch(/front-1/);
    const tool = setQaTool.mock.calls.at(-1)![0]!.map((file) => file.path);
    expect(tool).toContain('run.ts');
    expect(tool.some((path) => path.startsWith('tickets/') || path === 'manifest.json' || path.startsWith('story.'))).toBe(false);
  });

  it('starts without the project content when nothing was downloaded yet, and downloads it in the background', async () => {
    let release: (value: unknown) => void = () => {};
    const later = new Promise((resolve) => (release = resolve));
    const first: ContentSource = {
      kind: 'github',
      describe: () => 'mock',
      current: async () => null,
      publication: () => localSource().prepare(),
      codeOf: (entry) => localSource().codeOf(entry),
      prepare: async () => {
        await later;
        return localSource().prepare();
      },
      fetchTicket: (id: string) => localSource().fetchTicket(id),
    };
    const { game } = createGame({ content: first });
    await game.init();
    expect(game.snapshot().projectStory).toBeNull();
    release(undefined);
    await game.contentLoaded();
    expect(game.snapshot().projectStory?.en.client.name).toBe('Notes Inc.');
  });

  it('downloads the project before installing the environment, and asks for internet the first time', async () => {
    const order: string[] = [];
    const offline: ContentSource = {
      kind: 'github',
      describe: () => 'mock',
      current: async () => null,
      publication: () => Promise.reject(new FirstDownloadError('offline')),
      codeOf: () => Promise.reject(new Error('offline')),
      prepare: async () => {
        order.push('prepare');
        throw new FirstDownloadError('offline');
      },
      fetchTicket: () => Promise.reject(new Error('offline')),
    };
    const { game, runtime } = createGame({ content: offline });
    vi.spyOn(runtime, 'installEnvironment').mockImplementation(async () => {
      order.push('install');
    });
    await game.init();
    await game.contentLoaded();
    order.length = 0;
    await expect(game.installEnvironment()).rejects.toMatchObject({ code: 'contentNeedsInternet' });
    expect(order).toEqual(['prepare']);
  });

  it('leaves the workspace untouched when the download fails, and can retry', async () => {
    const failing: ContentSource = {
      kind: 'github',
      describe: () => 'mock',
      prepare: () => localSource().prepare(),
      current: () => localSource().current(),
      fetchTicket: vi.fn().mockRejectedValueOnce(new Error('network down')).mockImplementation((id: string) => localSource().fetchTicket(id)),
      publication: () => localSource().prepare(),
      codeOf: (entry) => localSource().codeOf(entry),
    };
    const { game, runtime } = createGame({ content: failing });
    const importStage = vi.spyOn(runtime, 'importStage');
    await game.init();
    await expect(game.nextAssignment()).rejects.toThrow('network down');
    expect(importStage).not.toHaveBeenCalled();
    expect(game.current.tickets).toEqual([]);
    expect(game.snapshot().busy).toBeNull();
    await game.nextAssignment();
    expect(importStage).toHaveBeenCalledTimes(1);
    expect(game.current.currentTicket).toBe(1);
  });

  it('ends the queue when a newer publication has fewer tickets, without touching the game', async () => {
    const { game, runtime } = createGame({ scenario: { qa: ['passed'] } });
    await game.init();
    await game.nextAssignment();
    await game.move(1, 'inProgress');
    await game.move(1, 'inQa');
    await game.waitForQa();
    await game.acceptReview(1);
    const before = game.current.tickets;
    const shrunk: ContentSource = {
      kind: 'github',
      describe: () => 'mock',
      prepare: () => localSource().prepare(),
      current: () => localSource().current(),
      fetchTicket: (id: string) => Promise.reject(new TicketNotPublishedError(id, { front: 1, back: 0 })),
      publication: () => localSource().prepare(),
      codeOf: (entry) => localSource().codeOf(entry),
    };
    (game as unknown as { source: ContentSource }).source = shrunk;
    const importStage = vi.spyOn(runtime, 'importStage');
    await expect(game.nextAssignment()).rejects.toMatchObject({ code: 'noMoreTickets' });
    expect(game.current.tracks).toEqual({ front: 1, back: 0 });
    expect(game.current.tickets).toEqual(before);
    expect(game.current.inbox.filter((message) => message.kind === 'completion')).toHaveLength(1);
    expect(importStage).not.toHaveBeenCalled();
  });

  it('shows the Projects screen from the start only when development asks for it', async () => {
    const shown = createGame({ devShowProjects: true }).game;
    await shown.init();
    expect(shown.snapshot().projectsUnlocked).toBe(true);
    const hidden = createGame().game;
    await hidden.init();
    expect(hidden.snapshot().projectsUnlocked).toBe(false);
  });

  it('shows the queue of each track in the snapshot', async () => {
    const { game } = createGame();
    await game.init();
    const { queues } = game.snapshot();
    expect(queues?.front).toMatchObject({ next: { id: 'front-1', track: 'front' }, done: 0, total: 2 });
    expect(queues?.front.next?.title.pt).toBe('Um título vazio não mostra nada');
    expect(queues?.back).toMatchObject({ next: { id: 'back-1', track: 'back' }, done: 0, total: 1 });
    expect(queues?.back.next?.title.en).toBe('Search is case-sensitive');
    expect(queues?.fullstack).toMatchObject({ next: { id: 'front-1' }, done: 0, total: 3 });
  });

  it('unlocks the next ticket of the chosen track', async () => {
    const { game } = createGame();
    await game.init();
    await game.nextAssignment('back');
    expect(rules.findTicket(game.current, 1)).toMatchObject({ id: 'back-1', track: 'back' });
    // The notes project has one back ticket: its queue has nothing left after it.
    expect(game.snapshot().queues?.back.next).toBeNull();
    // Fullstack alternates: after a back ticket comes a front one.
    expect(game.snapshot().queues?.fullstack.next?.id).toBe('front-1');
    // The open ticket must be Done first.
    expect(game.snapshot().nextTicket).toBeNull();
  });

  it('shows an incomplete publication with its own error code', async () => {
    const incomplete: ContentSource = {
      kind: 'github',
      describe: () => 'mock',
      prepare: () => localSource().prepare(),
      current: () => localSource().current(),
      fetchTicket: () => Promise.reject(new IncompletePublicationError('no commit')),
      publication: () => localSource().prepare(),
      codeOf: (entry) => localSource().codeOf(entry),
    };
    const { game } = createGame({ content: incomplete });
    await game.init();
    await expect(game.nextAssignment()).rejects.toMatchObject({ code: 'incompletePublication' });
  });

  it('plays a ticket: QA fails, hints, solution, QA passes, review, Done, next ticket', async () => {
    const { game } = createGame({ scenario: { qa: ['gate2', 'passed'] } });
    await game.init();
    await game.nextAssignment();
    await game.move(1, 'inProgress');

    await game.move(1, 'inQa');
    expect(status(game)).toBe('inQa');
    expect(game.snapshot().busy).toBe('qa');
    await game.waitForQa();
    expect(status(game)).toBe('inProgress');
    expect(rules.findTicket(game.current, 1)!.comments.at(-1)!.kind).toBe('gate2Failed');

    const hints = game.snapshot().hintsTotal[1]!;
    for (let hint = 1; hint <= hints; hint += 1) {
      await game.askSenior(1);
      expect((await game.ticketContent(1, 'pt')).hints).toHaveLength(hint);
    }
    await expect(game.askSenior(1)).rejects.toMatchObject({ code: 'noMoreHints' });
    await game.revealSolution(1);
    const revealed = await game.ticketContent(1, 'en');
    expect(revealed.solutionMarkdown).toContain('client/notes.js');
    expect(revealed.referencePatch).toContain('diff --git');
    expect(revealed.reviewMarkdown).toBeNull();

    await game.move(1, 'inQa');
    await game.waitForQa();
    expect(status(game)).toBe('codeReview');
    const review = await game.ticketContent(1, 'en');
    expect(review.reviewMarkdown).toContain('client/notes.js');
    expect(review.playerDiff).toContain('activeEmployees'); // the approved snapshot against the stage

    await expect(game.nextAssignment()).rejects.toMatchObject({ code: 'ticketNotDone' });
    await game.acceptReview(1);
    expect(status(game)).toBe('done');
    await game.nextAssignment();
    expect(game.current.currentTicket).toBe(2);
    expect(game.current.inbox.filter((message) => message.kind === 'assignment')).toHaveLength(2);
  });

  it('resets the workspace to the stage when the ticket starts, and only then', async () => {
    const { game, runtime } = createGame({ scenario: { qa: ['gate2', 'passed'] } });
    await game.init();
    await game.nextAssignment();
    expect(runtime.resets).toEqual([]);
    await game.move(1, 'inProgress');
    expect(runtime.resets).toEqual([1]);
    // A failed QA run returns the card to In Progress without touching the player's work.
    await game.move(1, 'inQa');
    await game.waitForQa();
    expect(rules.findTicket(game.current, 1)!.status).toBe('inProgress');
    expect(runtime.resets).toEqual([1]);
  });

  it('needs Docker to start a ticket, and leaves the card in To Do otherwise', async () => {
    const { game, runtime } = createGame({ scenario: { stopDockerAfterUnlock: true } });
    await game.init();
    await game.nextAssignment();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await expect(game.move(1, 'inProgress')).rejects.toMatchObject({ code: 'dockerUnavailable' });
    expect(rules.findTicket(game.current, 1)!.status).toBe('todo');
    expect(runtime.resets).toEqual([]);
  });

  it('solves the bug with the reference patch only when enabled, and only for the ticket in progress', async () => {
    const off = createGame();
    await off.game.init();
    await off.game.nextAssignment();
    expect(off.game.snapshot().devSolveBug).toBe(false);
    await expect(off.game.solveBug(1)).rejects.toMatchObject({ code: 'solveBugNotAllowed' });
    await off.game.move(1, 'inProgress');
    await expect(off.game.solveBug(1)).rejects.toMatchObject({ code: 'solveBugNotAllowed' });
    expect(off.runtime.solved).toEqual([]);

    // The same saved game, with the development flag on (the workspace volume still holds the repository).
    const { game, runtime } = createGame({ devSolveBug: true, scenario: { repository: true } });
    await game.init();
    expect(game.snapshot().devSolveBug).toBe(true);
    await expect(game.solveBug(2)).rejects.toMatchObject({ code: 'solveBugNotAllowed' });
    await game.solveBug(1);
    expect(runtime.solved).toHaveLength(1);
    expect(runtime.solved[0].stage).toBe(1);
    expect(runtime.solved[0].patch).toContain('diff --git');
  });

  it('opens the onboarding until it is finished, and keeps that in the saved game', async () => {
    const { game } = createGame();
    await game.init();
    expect(game.snapshot()).toMatchObject({ onboardingDue: true, devSkipOnboarding: false });
    await game.finishOnboarding();
    expect(game.snapshot().onboardingDue).toBe(false);

    // The same saved game after a restart; a new game shows it again.
    const restarted = createGame({ devSkipOnboarding: true });
    await restarted.game.init();
    expect(restarted.game.snapshot()).toMatchObject({ onboardingDue: false, devSkipOnboarding: true });
    await restarted.game.newGame();
    expect(restarted.game.snapshot().onboardingDue).toBe(true);
  });

  it('does not open the onboarding on its own when told not to (the e2e tests)', async () => {
    const { game } = createGame({ autoOnboarding: false });
    await game.init();
    expect(game.snapshot().onboardingDue).toBe(false);
  });

  it('enforces the drag rules in the main process', async () => {
    const { game } = createGame();
    await game.init();
    await game.nextAssignment();
    await expect(game.move(1, 'inQa')).rejects.toMatchObject({ code: 'moveNotAllowed' });
    await expect(game.move(1, 'done')).rejects.toMatchObject({ code: 'moveNotAllowed' });
    await game.move(1, 'inProgress');
    await expect(game.move(1, 'codeReview')).rejects.toMatchObject({ code: 'moveNotAllowed' });
    await expect(game.move(1, 'todo')).rejects.toMatchObject({ code: 'moveNotAllowed' });
    await expect(game.move(2, 'inProgress')).rejects.toMatchObject({ code: 'noSuchTicket' });
  });

  it('does not move the card when the environment is not ready', async () => {
    const { game } = createGame({ scenario: { environmentReady: false } });
    await game.init();
    await game.nextAssignment();
    await game.move(1, 'inProgress');
    await expect(game.move(1, 'inQa')).rejects.toMatchObject({ code: 'environmentNotReady' });
    expect(status(game)).toBe('inProgress');
    // QA was reserved for the checks and is released when it cannot start.
    expect(game.snapshot().busy).toBeNull();
  });

  it('reserves QA before its slow checks, so no other task starts in between', async () => {
    const { game, runtime } = createGame({ scenario: { qa: ['passed'] } });
    await game.init();
    await game.nextAssignment();
    await game.move(1, 'inProgress');
    let release: (() => void) | undefined;
    const environment = runtime.environment.bind(runtime);
    vi.spyOn(runtime, 'environment').mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return environment();
    });
    const submit = game.move(1, 'inQa');
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(game.snapshot().busy).toBe('qa');
    await expect(game.cleanDockerLeftovers()).rejects.toMatchObject({ code: 'busy' });
    release!();
    await submit;
    await game.waitForQa();
    expect(status(game)).toBe('codeReview');
    expect(game.snapshot().busy).toBeNull();
  });

  it('opens VS Code during QA but not during other tasks, and never brings the code back while another task runs', async () => {
    const { game, runtime } = createGame({ scenario: { qa: ['passed'], qaDelayMs: 200 } });
    await game.init();
    await game.nextAssignment();
    await game.move(1, 'inProgress');
    const openVSCode = vi.spyOn(runtime, 'openVSCode');
    await game.move(1, 'inQa');
    await game.openVSCode();
    expect(openVSCode).toHaveBeenCalledTimes(1);
    await game.waitForQa();

    // A cleanup that waits until released: an exclusive task in progress.
    let release: (() => void) | undefined;
    const clean = runtime.cleanDocker.bind(runtime);
    vi.spyOn(runtime, 'cleanDocker').mockImplementation(async (scope) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return clean(scope);
    });
    const blockWorkspace = async () => {
      release = undefined;
      const cleaning = game.cleanDockerLeftovers();
      await vi.waitFor(() => expect(release).toBeDefined());
      return async () => {
        release!();
        await cleaning;
      };
    };

    await game.openReview(1);
    expect(game.current.reviewSession).not.toBeNull();
    const unblock = await blockWorkspace();
    await expect(game.openVSCode()).rejects.toMatchObject({ code: 'busy' });
    // An action refused as busy leaves the review checked out: nothing ran before the busy check.
    await expect(game.exportProgress(join(dir, 'progress.bdsave'))).rejects.toMatchObject({ code: 'busy' });
    expect(game.current.reviewSession).not.toBeNull();
    expect(openVSCode).toHaveBeenCalledTimes(1);
    await unblock();

    // With nothing else running, opening VS Code on the player's code brings it back first.
    await game.openVSCode();
    expect(game.current.reviewSession).toBeNull();
    expect(openVSCode).toHaveBeenCalledTimes(2);
  });

  it('pauses Docker actions while Docker is stopped', async () => {
    const { game } = createGame({ scenario: { docker: 'notRunning' } });
    await game.init();
    await expect(game.nextAssignment()).rejects.toMatchObject({ code: 'dockerUnavailable' });
    expect(game.snapshot().dockerState).toBe('notRunning');
  });

  it('warns when QA starts on another branch, and still evaluates', async () => {
    const { game } = createGame({ scenario: { branch: 'main', qa: ['passed'] } });
    await game.init();
    await game.nextAssignment();
    await game.move(1, 'inProgress');
    await game.move(1, 'inQa');
    await game.waitForQa();
    const ticket = rules.findTicket(game.current, 1)!;
    expect(ticket.comments.map((comment) => comment.kind)).toEqual(['branchWarning', 'passed']);
    expect(ticket.attempts[0]).toMatchObject({ branch: 'main', branchWarning: true });
    expect(ticket.status).toBe('codeReview');
  });

  it('does not count an infrastructure error as an attempt', async () => {
    const { game } = createGame({ scenario: { qa: ['error'] } });
    await game.init();
    await game.nextAssignment();
    await game.move(1, 'inProgress');
    await game.move(1, 'inQa');
    await game.waitForQa();
    const ticket = rules.findTicket(game.current, 1)!;
    expect(ticket.status).toBe('inProgress');
    expect(ticket.attempts).toHaveLength(0);
    expect(ticket.comments.at(-1)).toMatchObject({ kind: 'error' });
  });

  it('recovers a QA run interrupted by a closed app on the next start', async () => {
    const ctx = { now: new Date().toISOString(), id: () => crypto.randomUUID() };
    let state = rules.unlockTicket(rules.createInitialState(ctx), 1, unlocked(1, 'abc'), ctx);
    state = rules.playerMove(state, 1, 'inProgress', ctx);
    state = rules.playerMove(state, 1, 'inQa', ctx);
    await writeFile(join(dir, 'state.json'), JSON.stringify(state));
    const { game } = createGame();
    await game.init();
    const ticket = rules.findTicket(game.current, 1)!;
    expect(ticket.status).toBe('inProgress');
    expect(ticket.attempts).toHaveLength(0);
    expect(ticket.comments.at(-1)!.kind).toBe('interrupted');
    // Persisted, so a second restart does not add another comment.
    const { game: again } = createGame();
    await again.init();
    expect(rules.findTicket(again.current, 1)!.comments).toHaveLength(1);
  });

  it('starts a new game: resets the board and claims the workspace for the new game', async () => {
    const { game, runtime } = createGame({ scenario: { qa: ['passed'] } });
    await game.init();
    await game.updateSettings({ language: 'pt', qaTimeoutSeconds: 240 });
    await game.nextAssignment();
    const firstGame = game.current.createdAt;
    expect(runtime.claimed).toBe(firstGame);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await game.newGame();
    expect(game.current.tickets).toEqual([]);
    expect(game.current.currentTicket).toBeNull();
    expect(game.current.createdAt).not.toBe(firstGame);
    expect(game.current.settings).toMatchObject({ language: 'pt', qaTimeoutSeconds: 240 });
    expect(game.current.inbox.map((message) => message.kind)).toEqual(['welcome']);

    const claim = vi.spyOn(runtime, 'claimWorkspace');
    await game.nextAssignment();
    expect(claim).toHaveBeenCalledWith(game.current.createdAt);
    expect(await claim.mock.results[0].value).toBe(1);
    expect(game.snapshot().log.some((line) => line.includes('Kept the code of a previous game'))).toBe(true);
    expect(game.current.currentTicket).toBe(1);
  });

  it('records the last export in the state and in the save, and forgets it on a new game', async () => {
    const { game } = createGame();
    await game.init();
    await game.nextAssignment();
    expect(backupStatus(game.current)).toBe('outdated');

    const file = join(dir, 'Meus saves', 'bug-detective-2026-10-24.bdsave');
    await mkdir(join(dir, 'Meus saves'));
    await game.exportProgress(file);
    expect(game.current.lastExport).toEqual({ at: expect.any(String), path: file });
    expect(backupStatus(game.current)).toBe('current');
    // Saved with the game, and inside the save itself: there with the file name only, never this computer's folder.
    expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).lastExport.path).toBe(file);
    const saved = readZip(new Uint8Array(await readFile(file))).find((entry) => entry.path === 'state.json')!;
    expect(JSON.parse(Buffer.from(saved.data).toString('utf8')).lastExport).toEqual({ at: game.current.lastExport!.at, path: 'bug-detective-2026-10-24.bdsave' });
    expect(Buffer.from(await readFile(file)).toString('latin1')).not.toContain('Meus saves');

    await new Promise((resolve) => setTimeout(resolve, 5));
    await game.move(1, 'inProgress');
    expect(backupStatus(game.current)).toBe('outdated');

    await game.newGame();
    expect(game.current.lastExport).toBeUndefined();
    expect(backupStatus(game.current)).toBe('none');
  });

  it('keeps one save to restore at a time, and drops it when the restore is cancelled', async () => {
    const { game, runtime } = createGame();
    // A save with progress needs the workspace repository; the fake runtime has none of its own.
    vi.spyOn(runtime as GameRuntime, 'bundle').mockResolvedValue(new Uint8Array(Buffer.from('# v2 git bundle\n')));
    await game.init();
    await game.nextAssignment();
    const file = join(dir, 'progress.bdsave');
    await game.exportProgress(file);

    const first = await game.inspectSave(file, 'progress.bdsave');
    const second = await game.inspectSave(file, 'progress.bdsave');
    // Choosing another file replaces the first choice.
    await expect(game.restoreProgress(first.token)).rejects.toMatchObject({ code: 'invalidSave' });
    await game.discardSave(second.token);
    await expect(game.restoreProgress(second.token)).rejects.toMatchObject({ code: 'invalidSave' });

    const third = await game.inspectSave(file, 'progress.bdsave');
    await game.discardSave(first.token);
    await game.restoreProgress(third.token);
    expect(game.current.currentTicket).toBe(1);
  });

  it('answers the workspace status from the last check while another task changes the workspace', async () => {
    const { game, runtime } = createGame();
    await game.init();
    await game.nextAssignment();
    const first = await game.workspaceStatus();
    const status = vi.spyOn(runtime, 'workspaceStatus');
    let release: (() => void) | undefined;
    const clean = runtime.cleanDocker.bind(runtime);
    vi.spyOn(runtime, 'cleanDocker').mockImplementation(async (scope) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return clean(scope);
    });
    const cleaning = game.cleanDockerLeftovers();
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(await game.workspaceStatus()).toEqual(first);
    expect(status).not.toHaveBeenCalled();
    release!();
    await cleaning;
    await game.workspaceStatus();
    expect(status).toHaveBeenCalledTimes(1);
  });

  it('measures disk usage only while Docker runs', async () => {
    const { game } = createGame({ scenario: { docker: 'notRunning' } });
    await game.init();
    await expect(game.diskUsage()).rejects.toMatchObject({ code: 'dockerUnavailable' });
    const running = createGame().game;
    await running.init();
    expect((await running.diskUsage()).map((item) => item.id)).toEqual(['workspaceVolume', 'workspaceImage', 'qaImage', 'qaCache']);
  });

  it('clamps the QA timeout setting', async () => {
    const { game } = createGame();
    await game.init();
    await game.updateSettings({ qaTimeoutSeconds: 5 });
    expect(game.current.settings.qaTimeoutSeconds).toBe(60);
    await game.updateSettings({ qaTimeoutSeconds: 5000 });
    expect(game.current.settings.qaTimeoutSeconds).toBe(1800);
    await game.updateSettings({ qaTimeoutSeconds: 240, language: 'pt' });
    expect(game.current.settings).toMatchObject({ qaTimeoutSeconds: 240, language: 'pt' });
  });

  it('cleans up Docker leftovers without touching the game', async () => {
    const { game, runtime } = createGame();
    await game.init();
    await game.nextAssignment();
    const clean = vi.spyOn(runtime, 'cleanDocker');
    const result = await game.cleanDockerLeftovers();
    expect(clean).toHaveBeenCalledWith('leftovers');
    expect(result).toEqual({ removed: 3, failed: [] });
    expect(game.current.currentTicket).toBe(1);
    expect(game.snapshot().busy).toBeNull();
  });

  it('removes everything from Docker and starts a new game, even with a review checked out', async () => {
    const { game, runtime } = createGame({ scenario: { qa: ['passed'], cleanupFails: ['bugdetective-qa-cache'] } });
    await game.init();
    await game.updateSettings({ language: 'pt' });
    await game.nextAssignment();
    await game.move(1, 'inProgress');
    await game.move(1, 'inQa');
    await game.waitForQa();
    await game.openReview(1);
    expect(game.current.reviewSession).not.toBeNull();
    const firstGame = game.current.createdAt;

    await new Promise((resolve) => setTimeout(resolve, 5));
    const clean = vi.spyOn(runtime, 'cleanDocker');
    const result = await game.removeDockerData();
    expect(clean).toHaveBeenCalledWith('everything');
    // A failure is reported, and the rest still goes.
    expect(result.failed).toEqual([{ kind: 'volume', name: 'bugdetective-qa-cache', reason: 'Error response from daemon: bugdetective-qa-cache is in use' }]);
    expect(result.removed).toBe(8);
    expect(result.workspaceKept).toBe(false);
    expect(game.current.createdAt).not.toBe(firstGame);
    expect(game.current.tickets).toEqual([]);
    expect(game.current.reviewSession).toBeNull();
    expect(game.current.settings.language).toBe('pt');
    // The images are gone too: the next assignment needs the downloads again.
    expect(game.snapshot().environment?.ready).toBe(false);
  });

  it('keeps the game when the volume with the code could not be removed', async () => {
    const { game } = createGame({ scenario: { cleanupFails: ['bugdetective-workspace'] } });
    await game.init();
    await game.nextAssignment();
    const createdAt = game.current.createdAt;
    const result = await game.removeDockerData();
    expect(result.workspaceKept).toBe(true);
    expect(result.failed.map((item) => `${item.kind} ${item.name}`)).toEqual(['container bugdetective-workspace', 'volume bugdetective-workspace']);
    expect(game.current.createdAt).toBe(createdAt);
    expect(game.current.currentTicket).toBe(1);
  });

  it('runs the whole removal as one task: no other action starts in between', async () => {
    const { game, runtime } = createGame();
    await game.init();
    let release!: () => void;
    const clean = runtime.cleanDocker.bind(runtime);
    vi.spyOn(runtime, 'cleanDocker').mockImplementation(async (scope) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return clean(scope);
    });
    const removal = game.removeDockerData();
    await vi.waitFor(() => expect(game.snapshot().busy).toBe('removingDocker'));
    await expect(game.removeDockerData()).rejects.toMatchObject({ code: 'busy' });
    await expect(game.cleanDockerLeftovers()).rejects.toMatchObject({ code: 'busy' });
    release();
    await removal;
    expect(game.snapshot().busy).toBeNull();
  });

  it('refuses to remove everything while QA runs or Docker is stopped', async () => {
    const running = createGame({ scenario: { qaDelayMs: 200 } });
    await running.game.init();
    await running.game.nextAssignment();
    await running.game.move(1, 'inProgress');
    await running.game.move(1, 'inQa');
    await expect(running.game.removeDockerData()).rejects.toMatchObject({ code: 'busy' });
    await running.game.waitForQa();

    const stopped = createGame({ scenario: { docker: 'notRunning' } });
    await stopped.game.init();
    await expect(stopped.game.removeDockerData()).rejects.toThrow();
    await expect(stopped.game.cleanDockerLeftovers()).rejects.toThrow();
  });
});

/** A content source whose manifests carry the given version (the local source always says 0.0.0). */
function withVersion(source: ContentSource, version: () => string): ContentSource {
  const content = (value: ProjectContent): ProjectContent => ({ ...value, manifest: { ...value.manifest, version: version() } });
  return {
    kind: source.kind,
    describe: () => source.describe(),
    prepare: async (signal) => content(await source.prepare(signal)),
    current: async () => {
      const value = await source.current();
      return value ? content(value) : null;
    },
    fetchTicket: async (id, signal) => ({ ...(await source.fetchTicket(id, signal)), manifestVersion: version() }),
    publication: async (requested, signal) => content(await source.publication(requested, signal)),
    codeOf: (entry, signal) => source.codeOf(entry, signal),
  };
}

/** A projects catalog whose list a test can change; counts its refreshes. */
function fakeCatalog(initial: ResolvedProject[]) {
  let list = initial;
  return {
    refreshes: 0,
    failRefresh: false,
    async current() {
      return list;
    },
    async refresh() {
      this.refreshes += 1;
      if (this.failRefresh) throw new Error('offline');
      return true;
    },
    set(next: ResolvedProject[]) {
      list = next;
    },
  };
}

describe('Game with several projects', () => {
  async function twoProjects(runtime = new FakeRuntime(JSON.stringify({ qaDelayMs: 1, qa: ['passed'] })), firstFront = 1, firstBrief: ProjectBrief = {}) {
    const repos = {
      first: await createProjectRepo(join(dir, 'repos'), { front: firstFront, back: 0 }, 'First', 'first', firstBrief),
      second: await createProjectRepo(join(dir, 'repos'), { front: 1, back: 1 }, 'Second'),
    };
    const sources: { id: string; repository: string; minVersion: string | null }[] = [];
    const versions: Record<string, string> = {};
    const broken: Record<string, Error> = {};
    // The repository each ticket was fetched from; a test may hold a fetch until it opens the gate.
    const fetched: string[] = [];
    let gate: Promise<void> = Promise.resolve();
    const hold = () => {
      let open!: () => void;
      gate = new Promise((resolve) => (open = resolve));
      return () => open();
    };
    const catalog = fakeCatalog([
      { id: 'first', repository: 'owner/first', qaRef: 'qa', starter: true, official: true },
      { id: 'second', repository: 'owner/second', qaRef: 'qa', starter: false, official: true },
    ]);
    const make = (extra: Partial<GameOptions> = {}) =>
      new Game({
        store: new StateStore(dir),
        packages: new PackageStore(join(dir, 'projects', 'first', 'packages')),
        reviews: new ReviewStore(join(dir, 'projects', 'first', 'reviews')),
        content: new LocalContentSource({ qaDir: repos.first.qaDir, runner: runCommand }),
        projects: {
          catalog,
          content: (project, minVersion) => {
            sources.push({ id: project.id, repository: project.repository, minVersion });
            if (broken[project.id] || project.qaDir === '/missing') {
              const error = broken[project.id] ?? new Error('/missing is not a qa folder');
              return {
                kind: 'github',
                describe: () => project.id,
                prepare: () => Promise.reject(error),
                current: async () => null,
                fetchTicket: () => Promise.reject(error),
                publication: () => Promise.reject(error),
                codeOf: () => Promise.reject(error),
              };
            }
            const source = withVersion(new LocalContentSource({ qaDir: repos[project.id as 'first' | 'second'].qaDir, runner: runCommand }), () => versions[project.id] ?? '0.0.0');
            return {
              ...source,
              fetchTicket: async (id, signal) => {
                fetched.push(project.qaRef === 'qa' ? project.repository : `${project.repository}@${project.qaRef}`);
                await gate;
                return source.fetchTicket(id, signal);
              },
            };
          },
          packages: (id) => new PackageStore(join(dir, 'projects', id, 'packages')),
          reviews: (id) => new ReviewStore(join(dir, 'projects', id, 'reviews')),
        },
        runtime,
        appVersion: '0.1.0',
        versions: { electron: 'test', node: process.versions.node, chrome: 'test' },
        ...extra,
      });
    return { make, runtime, catalog, sources, versions, broken, fetched, hold };
  }

  it('reports a catalog refresh that failed, and clears it when one succeeds', async () => {
    const { make, catalog } = await twoProjects();
    const game = make();
    await game.init();
    expect(game.snapshot().catalogRefresh).toBeNull();
    catalog.failRefresh = true;
    await game.refreshCatalog();
    expect(game.snapshot().catalogRefresh).toEqual({ failedAt: expect.any(String) });
    expect(game.snapshot().projects?.map((card) => card.id)).toEqual(['first', 'second']);
    catalog.failRefresh = false;
    await game.loadProjects();
    expect(game.snapshot().catalogRefresh).toBeNull();
  });

  async function finishFirstTicket(game: Game) {
    await game.nextAssignment('front');
    await game.move(1, 'inProgress');
    await game.move(1, 'inQa');
    await game.waitForQa();
    await game.acceptReview(1);
  }

  it('shows the Projects screen after a track is done, and switches with Docker cleaned', async () => {
    const { make, runtime } = await twoProjects();
    const game = make();
    await game.init();
    expect(game.snapshot().projectsUnlocked).toBe(false);
    await finishFirstTicket(game);
    expect(game.snapshot().projectsUnlocked).toBe(true);
    expect(game.snapshot().projects?.map((card) => [card.id, card.active])).toEqual([['first', true], ['second', false]]);

    const removeProjects = vi.spyOn(runtime, 'removeProjects');
    await game.switchProject('second');
    expect(removeProjects).toHaveBeenCalledWith(['first']);
    expect(game.current).toMatchObject({ project: 'second', projectSwitch: null, tickets: [] });
    expect(game.current.otherProjects.first.tickets).toHaveLength(1);
    expect(game.snapshot().queues?.back.next?.id).toBe('back-1');
    expect(game.snapshot().projectStory?.en.project.name).toBe('Second');
  });

  it('brings the progress back when the player returns to a project', async () => {
    const { make } = await twoProjects();
    const game = make();
    await game.init();
    await finishFirstTicket(game);
    await game.switchProject('second');
    await game.switchProject('first');
    expect(game.current.project).toBe('first');
    expect(game.current.tickets.map((ticket) => ticket.id)).toEqual(['front-1']);
    expect(Object.keys(game.current.otherProjects)).toEqual(['second']);
  });

  it('refuses to switch with a ticket open', async () => {
    const { make } = await twoProjects();
    const game = make();
    await game.init();
    await game.nextAssignment('front');
    await expect(game.switchProject('second')).rejects.toMatchObject({ code: 'ticketNotDone' });
    expect(game.current.project).toBe('first');
  });

  it('keeps an unfinished switch, blocks the game, and finishes it on the next start', async () => {
    const { make, runtime } = await twoProjects();
    const game = make();
    await game.init();
    await finishFirstTicket(game);
    vi.spyOn(runtime, 'removeProjects').mockResolvedValue([{ kind: 'volume', name: 'bugdetective-workspace' }]);
    await expect(game.switchProject('second')).rejects.toMatchObject({ code: 'switchIncomplete' });
    expect(game.current.projectSwitch).toMatchObject({ from: 'first', to: 'second' });
    expect(game.snapshot().projectSwitchLeft).toEqual([{ kind: 'volume', name: 'bugdetective-workspace' }]);
    await expect(game.nextAssignment('front')).rejects.toMatchObject({ code: 'switchIncomplete' });
    await expect(game.installEnvironment()).rejects.toMatchObject({ code: 'switchIncomplete' });

    vi.mocked(runtime.removeProjects).mockResolvedValue([]);
    const next = make();
    await next.init();
    expect(next.current).toMatchObject({ project: 'second', projectSwitch: null });
  });

  it('removes the other projects too when the player cleans Docker leftovers', async () => {
    const { make, runtime } = await twoProjects();
    const game = make();
    await game.init();
    const removeProjects = vi.spyOn(runtime, 'removeProjects').mockResolvedValue([]);
    await game.cleanDockerLeftovers();
    expect(removeProjects).toHaveBeenCalledWith(['second']);
  });

  it('removes what other projects left in Docker before installing the environment', async () => {
    const { make, runtime } = await twoProjects();
    const game = make();
    await game.init();
    const removeProjects = vi.spyOn(runtime, 'removeProjects').mockResolvedValue([{ kind: 'image', name: 'bugdetective-qa:old' }]);
    await expect(game.installEnvironment()).rejects.toMatchObject({ code: 'otherProjectsLeft' });
    expect(removeProjects).toHaveBeenCalledWith(['second']);
  });

  it('a project card carries the client, the stack and the skills of its brief', async () => {
    const { make } = await twoProjects(undefined, 1, { stack: { frontend: 'React · Vite', database: 'SQLite' }, skills: { en: ['Async and state'], pt: ['Assincronia e estado'] } });
    const game = make();
    await game.init();
    expect(game.snapshot().projects?.[0].details).toMatchObject({
      client: { en: 'Client', pt: 'Client' },
      stack: { frontend: 'React · Vite', database: 'SQLite' },
      skills: { en: ['Async and state'], pt: ['Assincronia e estado'] },
    });
  });

  it('a project without a stack or skills gets null and empty lists', async () => {
    const { make } = await twoProjects();
    const game = make();
    await game.init();
    expect(game.snapshot().projects?.[0].details).toMatchObject({ stack: null, skills: { en: [], pt: [] } });
  });

  it('fetches the next ticket of a project that moved from the repository the catalog now names', async () => {
    const { make, catalog, fetched } = await twoProjects();
    const game = make();
    await game.init();
    catalog.set([
      { id: 'first', repository: 'owner/moved', qaRef: 'qa', starter: true, official: true },
      { id: 'second', repository: 'owner/second', qaRef: 'qa', starter: false, official: true },
    ]);
    await game.refreshCatalog();
    await game.nextAssignment('front');
    expect(fetched).toEqual(['owner/moved']);
    expect(game.current.projectSources.first?.repository).toBe('owner/moved');
  });

  it('applies a catalog refreshed while a ticket is unlocked from the next ticket, never to that one', async () => {
    const { make, catalog, fetched, hold } = await twoProjects(undefined, 2);
    const game = make();
    await game.init();
    const open = hold();
    const unlocking = game.nextAssignment('front');
    await vi.waitFor(() => expect(fetched).toHaveLength(1));
    catalog.set([
      { id: 'first', repository: 'owner/moved', qaRef: 'qa', starter: true, official: true },
      { id: 'second', repository: 'owner/second', qaRef: 'qa', starter: false, official: true },
    ]);
    await game.refreshCatalog();
    open();
    await unlocking;
    expect(fetched).toEqual(['owner/first']);
    await game.move(1, 'inProgress');
    await game.move(1, 'inQa');
    await game.waitForQa();
    await game.acceptReview(1);
    await game.nextAssignment('front');
    expect(fetched).toEqual(['owner/first', 'owner/moved']);
  });

  /** Development settings kept in memory; applying them rebuilds the catalog from its qaRef and qaDir overrides. */
  function fakeDevCatalog(catalog: ReturnType<typeof fakeCatalog>, initial: LocalCatalog = {}) {
    const base: ResolvedProject[] = [
      { id: 'first', repository: 'owner/first', qaRef: 'qa', starter: true, official: true },
      { id: 'second', repository: 'owner/second', qaRef: 'qa', starter: false, official: true },
    ];
    let stored = initial;
    const dev = {
      written: [] as LocalCatalog[],
      reconfigured: [] as LocalCatalog[],
      failWrite: null as string | null,
      options: {
        file: '/desktop/catalog.local.json',
        testFile: false,
        read: async () => ({ settings: stored, error: null }),
        write: async (settings: LocalCatalog) => {
          if (dev.failWrite) throw new Error(dev.failWrite);
          dev.written.push(settings);
          stored = settings;
        },
        reconfigure: (settings: LocalCatalog) => {
          dev.reconfigured.push(settings);
          catalog.set(
            base.map((item) => {
              const override = settings.projects?.[item.id];
              if (!override) return item;
              return 'qaDir' in override ? { ...item, qaDir: override.qaDir, official: false } : { ...item, qaRef: override.qaRef, official: false };
            }),
          );
        },
      } satisfies DevCatalogOptions,
    };
    return dev;
  }

  it('shows no development settings in the installed app', async () => {
    const { make } = await twoProjects();
    const game = make();
    await game.init();
    expect(game.snapshot().devCatalog).toBeNull();
  });

  it('shows the development settings and the catalog in use', async () => {
    const { make, catalog } = await twoProjects();
    const dev = fakeDevCatalog(catalog, { projects: { second: { qaRef: 'qa-next' } } });
    const game = make({ devCatalog: dev.options });
    await game.init();
    expect(game.snapshot().devCatalog).toEqual({
      file: '/desktop/catalog.local.json',
      settings: { projects: { second: { qaRef: 'qa-next' } } },
      error: null,
      testFile: false,
      inUse: expect.any(String),
      fallback: false,
      projects: [
        { id: 'first', qaRef: 'qa', source: 'github: owner/first (qa)' },
        { id: 'second', qaRef: 'qa', source: 'github: owner/second (qa)' },
      ],
    });
  });

  it('applying writes the settings, reloads the catalog and takes the next ticket from the new source', async () => {
    const { make, catalog, fetched } = await twoProjects();
    const dev = fakeDevCatalog(catalog);
    const game = make({ devCatalog: dev.options });
    await game.init();
    const settings = { projects: { first: { qaRef: 'qa-next' } } };
    await game.applyDevCatalog(settings);
    expect(dev.written).toEqual([settings]);
    expect(dev.reconfigured).toEqual([settings]);
    expect(game.snapshot().devCatalog?.settings).toEqual(settings);
    expect(game.snapshot().devCatalog?.projects[0]).toEqual({ id: 'first', qaRef: 'qa-next', source: 'github: owner/first (qa-next)' });
    await game.nextAssignment('front');
    expect(fetched).toEqual(['owner/first@qa-next']);
  });

  it('applying keeps what the open ticket unlocked', async () => {
    const { make, catalog } = await twoProjects();
    const dev = fakeDevCatalog(catalog);
    const game = make({ devCatalog: dev.options });
    await game.init();
    await game.nextAssignment('front');
    const tickets = structuredClone(game.current.tickets);
    await game.applyDevCatalog({ projects: { first: { qaRef: 'qa-next' } } });
    expect(game.current.tickets).toEqual(tickets);
    expect((await game.ticketContent(1, 'en')).ticketMarkdown).not.toBe('');
  });

  it('refuses to apply the development settings in the installed app, while busy or during a project switch', async () => {
    const { make, catalog, fetched, hold, runtime } = await twoProjects();
    await expect(make().applyDevCatalog({})).rejects.toMatchObject({ code: 'notAllowed' });
    const dev = fakeDevCatalog(catalog);
    const game = make({ devCatalog: dev.options });
    await game.init();
    const open = hold();
    const unlocking = game.nextAssignment('front');
    await vi.waitFor(() => expect(fetched).toHaveLength(1));
    await expect(game.applyDevCatalog({ projects: { first: { qaRef: 'qa-next' } } })).rejects.toMatchObject({ code: 'busy' });
    open();
    await unlocking;
    await game.move(1, 'inProgress');
    await game.move(1, 'inQa');
    await game.waitForQa();
    await game.acceptReview(1);
    vi.spyOn(runtime, 'removeProjects').mockResolvedValue([{ kind: 'volume', name: 'bugdetective-workspace' }]);
    await expect(game.switchProject('second')).rejects.toMatchObject({ code: 'switchIncomplete' });
    await expect(game.applyDevCatalog({ projects: { first: { qaRef: 'qa-next' } } })).rejects.toMatchObject({ code: 'switchIncomplete' });
    expect(dev.written).toEqual([]);
  });

  it('refuses to apply the development settings while BUGDETECTIVE_CATALOG_FILE decides the catalog', async () => {
    const { make, catalog } = await twoProjects();
    const dev = fakeDevCatalog(catalog);
    const game = make({ devCatalog: { ...dev.options, testFile: true } });
    await game.init();
    await expect(game.applyDevCatalog({ projects: { first: { qaRef: 'qa-next' } } })).rejects.toMatchObject({ code: 'notAllowed' });
    expect(dev.written).toEqual([]);
  });

  it('reports development settings that cannot be written and applies nothing', async () => {
    const { make, catalog } = await twoProjects();
    const dev = fakeDevCatalog(catalog);
    dev.failWrite = 'Invalid catalog.local.json: projects.a: Invalid input';
    const game = make({ devCatalog: dev.options });
    await game.init();
    await expect(game.applyDevCatalog({ projects: { first: { qaRef: 'qa-next' } } })).rejects.toMatchObject({ code: 'invalidCatalogSettings' });
    expect(dev.reconfigured).toEqual([]);
    expect(game.snapshot().devCatalog?.error).toMatch(/Invalid catalog\.local\.json/);
  });

  it('a local folder that is not a qa folder fails the next ticket, and applying the published source fixes it without a restart', async () => {
    const { make, catalog, fetched } = await twoProjects();
    const dev = fakeDevCatalog(catalog);
    const game = make({ devCatalog: dev.options });
    await game.init();
    await game.applyDevCatalog({ projects: { first: { qaDir: '/missing' } } });
    await expect(game.nextAssignment('front')).rejects.toThrow(/missing/);
    await game.applyDevCatalog({});
    await game.nextAssignment('front');
    expect(fetched.at(-1)).toBe('owner/first');
    expect(game.current.tickets).toHaveLength(1);
  });

  it('starts a new game in the starter of the catalog in use', async () => {
    const { make, catalog } = await twoProjects();
    catalog.set([
      { id: 'first', repository: 'owner/first', qaRef: 'qa', starter: false, official: true },
      { id: 'second', repository: 'owner/second', qaRef: 'qa', starter: true, official: true },
    ]);
    const game = make();
    await game.init();
    expect(game.current.project).toBe('second');
    expect(game.snapshot().projectStory?.en.project.name).toBe('Second');
  });

  it('keeps a game in its project when the catalog later names another starter', async () => {
    const { make, catalog } = await twoProjects();
    const game = make();
    await game.init();
    await game.nextAssignment('front');
    catalog.set([
      { id: 'first', repository: 'owner/first', qaRef: 'qa', starter: false, official: true },
      { id: 'second', repository: 'owner/second', qaRef: 'qa', starter: true, official: true },
    ]);
    const next = make();
    await next.init();
    expect(next.current.project).toBe('first');
    expect(next.current.tickets.map((ticket) => ticket.id)).toEqual(['front-1']);
  });

  it('refreshes the catalog when the Projects screen opens and when a ticket is taken, even offline', async () => {
    const { make, catalog } = await twoProjects();
    const game = make();
    await game.init();
    await game.loadProjects();
    expect(catalog.refreshes).toBe(1);
    catalog.failRefresh = true;
    await game.nextAssignment('front');
    expect(catalog.refreshes).toBe(2);
    expect(game.current.tickets.map((ticket) => ticket.id)).toEqual(['front-1']);
  });

  it("records each project's source and raises its version floor, never lowering it", async () => {
    const { make, sources, versions } = await twoProjects();
    versions.first = '1.2.0';
    const game = make();
    await game.init();
    await game.nextAssignment('front');
    expect(game.current.projectSources.first).toEqual({ repository: 'owner/first', qaRef: 'qa', minVersion: '1.2.0' });

    versions.first = '1.1.0';
    const next = make();
    await next.init();
    expect(next.current.projectSources.first.minVersion).toBe('1.2.0');
    expect(sources.filter((item) => item.id === 'first').at(-1)?.minVersion).toBe('1.2.0');
  });

  it('never applies the floor to a source that is not the official one', async () => {
    const { make, catalog, sources, versions } = await twoProjects();
    versions.first = '1.2.0';
    const game = make();
    await game.init();
    await game.nextAssignment('front');
    catalog.set([
      { id: 'first', repository: 'owner/first', qaRef: 'qa', starter: true, official: false },
      { id: 'second', repository: 'owner/second', qaRef: 'qa', starter: false, official: true },
    ]);
    await make().init();
    expect(sources.filter((item) => item.id === 'first').at(-1)?.minVersion).toBeNull();
  });

  it('keeps the floor of a project across a switch and back', async () => {
    const { make, sources, versions } = await twoProjects();
    versions.first = '1.2.0';
    const game = make();
    await game.init();
    await finishFirstTicket(game);
    await game.switchProject('second');
    await game.switchProject('first');
    expect(sources.filter((item) => item.id === 'first').at(-1)?.minVersion).toBe('1.2.0');
  });

  it('follows the catalog when a project moves, and its stored source once it leaves the catalog', async () => {
    const { make, catalog, sources } = await twoProjects();
    const game = make();
    await game.init();
    catalog.set([
      { id: 'first', repository: 'owner/first-moved', qaRef: 'qa', starter: true, official: true },
      { id: 'second', repository: 'owner/second', qaRef: 'qa', starter: false, official: true },
    ]);
    await make().init();
    expect(sources.at(-1)).toMatchObject({ id: 'first', repository: 'owner/first-moved' });

    catalog.set([{ id: 'second', repository: 'owner/second', qaRef: 'qa', starter: true, official: true }]);
    const later = make();
    await later.init();
    expect(later.current.project).toBe('first');
    expect(sources.at(-1)).toMatchObject({ id: 'first', repository: 'owner/first-moved' });
  });

  it('finishes a pending switch to a project that left the catalog', async () => {
    const { make, runtime, catalog } = await twoProjects();
    const game = make();
    await game.init();
    await finishFirstTicket(game);
    vi.spyOn(runtime, 'removeProjects').mockResolvedValue([{ kind: 'volume', name: 'bugdetective-workspace' }]);
    await expect(game.switchProject('second')).rejects.toMatchObject({ code: 'switchIncomplete' });

    catalog.set([{ id: 'first', repository: 'owner/first', qaRef: 'qa', starter: true, official: true }]);
    vi.mocked(runtime.removeProjects).mockResolvedValue([]);
    const next = make();
    await next.init();
    expect(next.current).toMatchObject({ project: 'second', projectSwitch: null });
  });

  it('still removes from Docker a played project that left the catalog', async () => {
    const { make, runtime, catalog } = await twoProjects();
    const game = make();
    await game.init();
    await finishFirstTicket(game);
    await game.switchProject('second');
    await game.switchProject('first');
    catalog.set([{ id: 'first', repository: 'owner/first', qaRef: 'qa', starter: true, official: true }]);
    const next = make();
    await next.init();
    const removeProjects = vi.spyOn(runtime, 'removeProjects').mockResolvedValue([]);
    await next.cleanDockerLeftovers();
    expect(removeProjects).toHaveBeenCalledWith(['second']);
  });

  it('restores each project source and floor from a save', async () => {
    const { make, runtime, versions } = await twoProjects();
    vi.spyOn(runtime as GameRuntime, 'bundle').mockResolvedValue(new Uint8Array(Buffer.from('# v2 git bundle\n')));
    versions.first = '1.2.0';
    const game = make();
    await game.init();
    await game.nextAssignment('front');
    const file = join(dir, 'progress.bdsave');
    await game.exportProgress(file);
    versions.first = '1.0.0';
    await game.newGame();
    expect(game.current.projectSources).toEqual({ first: { repository: 'owner/first', qaRef: 'qa', minVersion: '1.0.0' } });

    const { token } = await game.inspectSave(file, 'progress.bdsave');
    await game.restoreProgress(token);
    expect(game.current.projectSources.first.minVersion).toBe('1.2.0');
  });

  it('marks a project that needs a newer app, and refuses to switch to it', async () => {
    const { make, catalog } = await twoProjects();
    catalog.set([{ id: 'first', repository: 'owner/first', qaRef: 'qa', starter: true, official: true }, { id: 'second', repository: 'owner/second', qaRef: 'qa', starter: false, official: true, minAppVersion: '99.0.0' }]);
    const game = make();
    await game.init();
    await finishFirstTicket(game);
    expect(game.snapshot().projects?.map((card) => [card.id, card.unavailable])).toEqual([['first', null], ['second', 'appTooOld']]);
    await expect(game.switchProject('second')).rejects.toMatchObject({ code: 'appTooOld' });
    expect(game.current.project).toBe('first');
  });

  it('marks a project whose content format is newer than this app understands', async () => {
    const { make, broken } = await twoProjects();
    broken.second = new UnsupportedFormatError(2);
    const game = make();
    await game.init();
    await game.loadProjects();
    expect(game.snapshot().projects?.find((card) => card.id === 'second')?.unavailable).toBe('appTooOld');
  });

  it('hides a hidden project, unless the player already played it', async () => {
    const { make, catalog } = await twoProjects();
    const game = make();
    await game.init();
    catalog.set([{ id: 'first', repository: 'owner/first', qaRef: 'qa', starter: true, official: true }, { id: 'second', repository: 'owner/second', qaRef: 'qa', starter: false, official: true, hidden: true }]);
    await game.loadProjects();
    expect(game.snapshot().projects?.map((card) => card.id)).toEqual(['first']);

    catalog.set([{ id: 'first', repository: 'owner/first', qaRef: 'qa', starter: true, official: true }, { id: 'second', repository: 'owner/second', qaRef: 'qa', starter: false, official: true }]);
    await game.loadProjects();
    await finishFirstTicket(game);
    await game.switchProject('second');
    catalog.set([{ id: 'first', repository: 'owner/first', qaRef: 'qa', starter: true, official: true }, { id: 'second', repository: 'owner/second', qaRef: 'qa', starter: false, official: true, hidden: true }]);
    await game.loadProjects();
    expect(game.snapshot().projects?.map((card) => card.id)).toEqual(['first', 'second']);
  });

  it('keeps a played project on the Projects screen after it leaves the catalog', async () => {
    const { make, catalog } = await twoProjects();
    const game = make();
    await game.init();
    await finishFirstTicket(game);
    await game.switchProject('second');
    catalog.set([{ id: 'first', repository: 'owner/first', qaRef: 'qa', starter: true, official: true }]);
    await game.loadProjects();
    expect(game.snapshot().projects?.map((card) => [card.id, card.active])).toEqual([['first', false], ['second', true]]);
  });

  it('tells a new game that its starter project needs a newer app', async () => {
    const { make, catalog } = await twoProjects();
    catalog.set([{ id: 'first', repository: 'owner/first', qaRef: 'qa', starter: true, official: true, minAppVersion: '99.0.0' }, { id: 'second', repository: 'owner/second', qaRef: 'qa', starter: false, official: true }]);
    const game = make();
    await game.init();
    expect(game.snapshot()).toMatchObject({ starterNeedsUpdate: true, projectNeedsUpdate: true });
  });

  it('tells a game in progress that its project now needs a newer app', async () => {
    const { make, catalog } = await twoProjects();
    const game = make();
    await game.init();
    await game.nextAssignment('front');
    expect(game.snapshot()).toMatchObject({ starterNeedsUpdate: false, projectNeedsUpdate: false });
    catalog.set([{ id: 'first', repository: 'owner/first', qaRef: 'qa', starter: true, official: true, minAppVersion: '99.0.0' }, { id: 'second', repository: 'owner/second', qaRef: 'qa', starter: false, official: true }]);
    await game.refreshCatalog();
    expect(game.snapshot()).toMatchObject({ starterNeedsUpdate: false, projectNeedsUpdate: true });
  });

  it('shows a project the catalog adds after a refresh', async () => {
    const { make, catalog } = await twoProjects();
    const game = make();
    await game.init();
    catalog.set([{ id: 'first', repository: 'owner/first', qaRef: 'qa', starter: true, official: true }]);
    await game.loadProjects();
    expect(game.snapshot().projects?.map((card) => card.id)).toEqual(['first']);
  });
});
