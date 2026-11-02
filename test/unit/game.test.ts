import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRuntime } from '../../src/main/fake-runtime.ts';
import { Game } from '../../src/main/game.ts';
import type { GameRuntime } from '../../src/main/runtime.ts';
import { LocalContentSource } from '../../src/main/services/content/local.ts';
import { FirstDownloadError } from '../../src/main/services/content/cache.ts';
import type { ResolvedProject } from '../../src/main/services/catalog.ts';
import { IncompletePublicationError, TicketNotPublishedError, readZip } from '@bug-detective/catalog/contract';
import type { ContentSource } from '../../src/main/services/content/source.ts';
import { PackageStore } from '../../src/main/services/content/store.ts';
import { runCommand } from '../../src/main/services/process.ts';
import { ReviewStore } from '../../src/main/services/review/store.ts';
import { StateStore } from '../../src/main/services/state.ts';
import * as rules from '../../src/shared/kanban.ts';
import { backupStatus } from '../../src/shared/types.ts';
import { unlocked } from '../helpers/tickets.ts';
import { createProjectRepo } from '../helpers/project-repo.ts';

// The real SupportDesk qa folder (a worktree of its qa branch) and its ticket branches.
const root = resolve(import.meta.dirname, '..', '..');
const localSource = () => new LocalContentSource({ qaDir: resolve(root, '..', 'supportdesk-qa'), runner: runCommand });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-game-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function createGame(
  options: { scenario?: object; content?: ContentSource; devSolveBug?: boolean; devSkipOnboarding?: boolean; devShowProjects?: boolean; autoOnboarding?: boolean } = {},
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
  });
  return { game, runtime };
}

const status = (game: Game, ticket = 1) => rules.findTicket(game.current, ticket)!.status;

describe('Game', () => {
  it('unlocks stage 1 from the local source and stores its package', async () => {
    const { game } = createGame();
    await game.init();
    await game.nextAssignment();
    expect(game.current.currentTicket).toBe(1);
    expect(game.current.tracks).toEqual({ front: 4, back: 4 });
    expect(rules.findTicket(game.current, 1)).toMatchObject({ id: 'front-1', track: 'front', manifestVersion: '0.0.0' });
    expect(status(game)).toBe('todo');
    expect(game.snapshot().titles[1].en).toMatch(/^SD-214:/);
    expect(game.snapshot().titles[1].pt).toMatch(/^SD-214:/);
    expect(game.snapshot().hintsTotal[1]).toBe(3);
    const content = await game.ticketContent(1, 'en');
    expect(content.ticketMarkdown).toContain('Previous');
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
    expect(game.snapshot().projectStory?.en.project.name).toBe('SupportDesk');
    expect(game.snapshot().projectStory?.pt.messages.assignments['front-1'].subject).toMatch(/SD-214/);
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
    expect(game.snapshot().projectStory?.en.client.name).toBe('Harborline Outfitters');
  });

  it('downloads the project before installing the environment, and asks for internet the first time', async () => {
    const order: string[] = [];
    const offline: ContentSource = {
      kind: 'github',
      describe: () => 'mock',
      current: async () => null,
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
    expect(queues?.front).toMatchObject({ next: { id: 'front-1', track: 'front' }, done: 0, total: 4 });
    expect(queues?.front.next?.title.pt).toMatch(/^SD-214:/);
    expect(queues?.back).toMatchObject({ next: { id: 'back-1', track: 'back' }, done: 0, total: 4 });
    expect(queues?.back.next?.title.en).toMatch(/^SD-252:/);
    expect(queues?.fullstack).toMatchObject({ next: { id: 'front-1' }, done: 0, total: 8 });
  });

  it('unlocks the next ticket of the chosen track', async () => {
    const { game } = createGame();
    await game.init();
    await game.nextAssignment('back');
    expect(rules.findTicket(game.current, 1)).toMatchObject({ id: 'back-1', track: 'back' });
    expect(game.snapshot().queues?.back.next?.id).toBe('back-2');
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

    for (let hint = 1; hint <= 3; hint += 1) {
      await game.askSenior(1);
      expect((await game.ticketContent(1, 'pt')).hints).toHaveLength(hint);
    }
    await game.revealSolution(1);
    const revealed = await game.ticketContent(1, 'en');
    expect(revealed.solutionMarkdown).toContain('Root cause');
    expect(revealed.referencePatch).toContain('diff --git');
    expect(revealed.reviewMarkdown).toBeNull();

    await game.move(1, 'inQa');
    await game.waitForQa();
    expect(status(game)).toBe('codeReview');
    const review = await game.ticketContent(1, 'en');
    expect(review.reviewMarkdown).toContain('Code review');
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

    // The same saved game, with the development flag on.
    const { game, runtime } = createGame({ devSolveBug: true });
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
    // Saved with the game, and inside the save itself.
    expect(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).lastExport.path).toBe(file);
    const saved = readZip(new Uint8Array(await readFile(file))).find((entry) => entry.path === 'state.json')!;
    expect(JSON.parse(Buffer.from(saved.data).toString('utf8')).lastExport).toEqual(game.current.lastExport);

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
    expect(result.removed).toBe(6);
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
  async function twoProjects(runtime = new FakeRuntime(JSON.stringify({ qaDelayMs: 1, qa: ['passed'] }))) {
    const repos = {
      first: await createProjectRepo(join(dir, 'repos'), { front: 1, back: 0 }, 'First'),
      second: await createProjectRepo(join(dir, 'repos'), { front: 1, back: 1 }, 'Second'),
    };
    const catalog = fakeCatalog([
      { id: 'first', repository: 'owner/first', qaRef: 'qa', starter: true, official: true },
      { id: 'second', repository: 'owner/second', qaRef: 'qa', starter: false, official: true },
    ]);
    const make = () =>
      new Game({
        store: new StateStore(dir),
        packages: new PackageStore(join(dir, 'projects', 'first', 'packages')),
        reviews: new ReviewStore(join(dir, 'projects', 'first', 'reviews')),
        content: new LocalContentSource({ qaDir: repos.first.qaDir, runner: runCommand }),
        projects: {
          catalog,
          content: (project) => new LocalContentSource({ qaDir: repos[project.id as 'first' | 'second'].qaDir, runner: runCommand }),
          packages: (id) => new PackageStore(join(dir, 'projects', id, 'packages')),
          reviews: (id) => new ReviewStore(join(dir, 'projects', id, 'reviews')),
        },
        runtime,
        appVersion: '0.1.0',
        versions: { electron: 'test', node: process.versions.node, chrome: 'test' },
      });
    return { make, runtime, catalog };
  }

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

  it('shows a project the catalog adds after a refresh', async () => {
    const { make, catalog } = await twoProjects();
    const game = make();
    await game.init();
    catalog.set([{ id: 'first', repository: 'owner/first', qaRef: 'qa', starter: true, official: true }]);
    await game.loadProjects();
    expect(game.snapshot().projects?.map((card) => card.id)).toEqual(['first']);
  });
});
