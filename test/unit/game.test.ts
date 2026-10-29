import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeRuntime } from '../../src/main/fake-runtime.ts';
import { Game } from '../../src/main/game.ts';
import { LocalContentSource } from '../../src/main/services/content/local.ts';
import type { ContentSource } from '../../src/main/services/content/source.ts';
import { PackageStore } from '../../src/main/services/content/store.ts';
import { runCommand } from '../../src/main/services/process.ts';
import { loadReviewConfig } from '../../src/main/services/review/config.ts';
import { ReviewStore } from '../../src/main/services/review/store.ts';
import { StateStore } from '../../src/main/services/state.ts';
import * as rules from '../../src/shared/kanban.ts';
import { backupStatus } from '../../src/shared/types.ts';
import { readZip } from '../../src/main/services/content/archive.ts';

// The real SupportDesk checkout and the manifest from `pnpm run build:stages`.
const root = resolve(import.meta.dirname, '..', '..');
const localSource = () =>
  new LocalContentSource({
    repoPath: resolve(root, '..', 'supportdesk-private'),
    manifestPath: join(root, 'build', 'stage-packages', 'manifest.json'),
    runner: runCommand,
  });

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-game-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function createGame(
  options: { scenario?: object; content?: ContentSource; devSolveBug?: boolean; devSkipOnboarding?: boolean; autoOnboarding?: boolean } = {},
) {
  const runtime = new FakeRuntime(JSON.stringify({ qaDelayMs: 1, ...options.scenario }));
  const game = new Game({
    store: new StateStore(dir),
    packages: new PackageStore(join(dir, 'packages')),
    reviews: new ReviewStore(join(dir, 'reviews')),
    review: loadReviewConfig('supportdesk'),
    content: options.content ?? localSource(),
    runtime,
    appVersion: '0.1.0',
    versions: { electron: 'test', node: process.versions.node, chrome: 'test' },
    devSolveBug: options.devSolveBug,
    devSkipOnboarding: options.devSkipOnboarding,
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

  it('leaves the workspace untouched when the download fails, and can retry', async () => {
    const failing: ContentSource = {
      kind: 'github',
      describe: () => 'mock',
      fetchStage: vi.fn().mockRejectedValueOnce(new Error('network down')).mockImplementation((stage: number) => localSource().fetchStage(stage)),
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
    let state = rules.unlockTicket(rules.createInitialState(ctx), 1, 'abc', ctx);
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
