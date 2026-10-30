import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeRuntime } from '../../src/main/fake-runtime.ts';
import { Game } from '../../src/main/game.ts';
import { createSave, readSave } from '../../src/main/services/backup.ts';
import { textFile } from '../../src/main/services/content/archive.ts';
import { LocalContentSource } from '../../src/main/services/content/local.ts';
import { PackageStore } from '../../src/main/services/content/store.ts';
import { runCommand } from '../../src/main/services/process.ts';
import { loadReviewConfig, parseReviewConfig } from '../../src/main/services/review/config.ts';
import { WIP_MESSAGE, editsStamp, readOnlySettings, reviewMessages } from '../../src/main/services/review/review.ts';
import { ReviewStore } from '../../src/main/services/review/store.ts';
import type { StoredReview } from '../../src/main/services/review/store.ts';
import { StateStore, migrateState } from '../../src/main/services/state.ts';
import * as rules from '../../src/shared/kanban.ts';
import { parseDiff, splitRows, visibleFiles } from '../../src/renderer/src/components/diff.ts';

const root = resolve(import.meta.dirname, '..', '..');
const ctx = { now: '2026-10-28T12:00:00.000Z', id: () => crypto.randomUUID() };
const sha = (char: string) => char.repeat(40);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-review-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The comparison (git diff -M output, parsed for the split view)

const MODIFIED = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1..2 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,4 +1,4 @@',
  ' keep',
  '-old one',
  '-old two',
  '+new one',
  ' end',
].join('\n');

describe('comparison diff', () => {
  it('detects added, deleted, renamed and binary files', () => {
    const files = parseDiff(
      [
        'diff --git a/only-mine.ts b/only-mine.ts',
        'deleted file mode 100644',
        '--- a/only-mine.ts',
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-mine',
        'diff --git a/only-reference.test.ts b/only-reference.test.ts',
        'new file mode 100644',
        '--- /dev/null',
        '+++ b/only-reference.test.ts',
        '@@ -0,0 +1 @@',
        '+test',
        'diff --git a/old/name.ts b/new/name.ts',
        'similarity index 100%',
        'rename from old/name.ts',
        'rename to new/name.ts',
        'diff --git a/logo.png b/logo.png',
        'Binary files a/logo.png and b/logo.png differ',
        MODIFIED,
      ].join('\n'),
    );
    expect(files.map((file) => [file.oldPath, file.path, file.status, file.binary])).toEqual([
      ['only-mine.ts', 'only-mine.ts', 'deleted', false],
      ['only-reference.test.ts', 'only-reference.test.ts', 'added', false],
      ['old/name.ts', 'new/name.ts', 'renamed', false],
      ['logo.png', 'logo.png', 'modified', true],
      ['src/a.ts', 'src/a.ts', 'modified', false],
    ]);
    // A pure rename has no lines but is still listed; so is a binary file.
    expect(visibleFiles(files)).toHaveLength(5);
  });

  it('hides a file whose remaining differences were only whitespace', () => {
    // git diff --ignore-all-space keeps the header of a whitespace-only file, without hunks.
    const files = parseDiff(['diff --git a/src/format.ts b/src/format.ts', 'index 1..2 100644', MODIFIED].join('\n'));
    expect(files).toHaveLength(2);
    expect(visibleFiles(files).map((file) => file.path)).toEqual(['src/a.ts']);
  });

  it('keeps content lines that look like headers inside a hunk, with their line numbers', () => {
    // A removed SQL comment "-- old" reads "--- old"; an added "++ x" reads "+++ x".
    const [file] = parseDiff(
      [
        'diff --git a/seed.sql b/seed.sql',
        'index 1..2 100644',
        '--- a/seed.sql',
        '+++ b/seed.sql',
        '@@ -1,3 +1,3 @@',
        '--- old comment',
        '+++ new counter',
        ' SELECT 1;',
        '-index 1;',
        '+index 2;',
        '\\ No newline at end of file',
      ].join('\n'),
    );
    expect(file.lines.map((line) => [line.kind, line.text, line.oldNumber, line.newNumber])).toEqual([
      ['hunk', '@@ -1,3 +1,3 @@', undefined, undefined],
      ['del', '-- old comment', 1, undefined],
      ['add', '++ new counter', undefined, 1],
      ['context', 'SELECT 1;', 2, 2],
      ['del', 'index 1;', 3, undefined],
      ['add', 'index 2;', undefined, 3],
    ]);
  });

  it('treats an empty diff as identical solutions', () => {
    expect(visibleFiles(parseDiff(''))).toEqual([]);
  });

  it('aligns removed and added lines side by side, by line number', () => {
    const [file] = parseDiff(MODIFIED);
    const rows = splitRows(file.lines).filter((row) => row.kind === 'line');
    expect(rows.map((row) => row.kind === 'line' && [row.left.number, row.left.kind, row.right.number, row.right.kind])).toEqual([
      [1, 'context', 1, 'context'],
      [2, 'del', 2, 'add'],
      [3, 'del', undefined, 'empty'],
      [4, 'context', 3, 'context'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers

describe('review helpers', () => {
  it('names the review commits in English, whatever the app language', () => {
    expect(reviewMessages(2)).toEqual({
      approved: 'Approved by QA — ticket 2',
      reference: 'Reference — ticket 2',
      snapshot: 'Your approved solution — ticket 2',
      edits: 'Changes made while viewing the review — ticket 2',
    });
  });

  it('makes every file read-only, keeping the project settings (JSONC)', () => {
    const merged = JSON.parse(readOnlySettings('{\n  // tabs\n  "editor.tabSize": 2, /* block */\n  "url": "http://x",\n}\n'));
    expect(merged).toEqual({ 'editor.tabSize': 2, url: 'http://x', 'files.readonlyInclude': { '**': true } });
    expect(JSON.parse(readOnlySettings(null))).toEqual({ 'files.readonlyInclude': { '**': true } });
    expect(JSON.parse(readOnlySettings('not json'))).toEqual({ 'files.readonlyInclude': { '**': true } });
  });

  it('stamps review-edits branches with a compact UTC time', () => {
    expect(editsStamp('2026-10-28T12:15:00.123Z')).toBe('20261028T121500Z');
  });
});

// ---------------------------------------------------------------------------
// Persistence

const stored = (ticket: number, snapshotText = 'mine\n'): StoredReview => ({
  meta: {
    ticket,
    approvedAt: ctx.now,
    language: 'en',
    commits: { approved: sha('a'), reference: sha('b'), snapshot: sha('c') },
    comparison: { solutions: MODIFIED, solutionsIgnoringWhitespace: MODIFIED, baseline: '', baselineIgnoringWhitespace: '' },
  },
  snapshot: [textFile('src/a.ts', snapshotText)],
  reference: [textFile('src/a.ts', 'reference\n')],
});

describe('review store', () => {
  it('keeps the approved snapshot immutable', async () => {
    const store = new ReviewStore(join(dir, 'reviews'));
    await store.save(stored(1));
    await store.save(stored(1)); // the same data again: a rebuild after a restore
    await expect(store.save(stored(1, 'edited after approval\n'))).rejects.toThrow(/cannot change/);
    expect((await store.load(1))!.snapshot[0].data).toEqual(textFile('x', 'mine\n').data);
    await store.save(stored(1, 'a new pass while still In QA\n'), { replace: true });
  });

  it('round-trips through a save file, and restores into an empty folder', async () => {
    const store = new ReviewStore(join(dir, 'reviews'));
    await store.save(stored(1));
    await store.save(stored(2));
    const state = { ...rules.createInitialState(ctx), tickets: [] };
    const save = readSave(createSave({ state, bundle: null, packages: new Map(), reviews: await store.exportFiles() }, '0.1.0', ctx.now), ctx);
    expect([...save.reviews.keys()]).toHaveLength(6);

    const restored = new ReviewStore(join(dir, 'restored'));
    await restored.importSave(save.reviews);
    expect(await restored.load(2)).toEqual(await store.load(2));
    expect(await restored.comparison(1)).toEqual(stored(1).meta.comparison);
  });

  it('restores saves made before reviews existed', async () => {
    const state = rules.createInitialState(ctx);
    const save = readSave(createSave({ state, bundle: null, packages: new Map() }, '0.1.0', ctx.now), ctx);
    expect(save.reviews.size).toBe(0);
  });
});

describe('state migration', () => {
  it('migrates a version 2 state with no review checked out', () => {
    const { reviewSession: _none, ...v2 } = { ...rules.createInitialState(ctx), schemaVersion: 2 };
    const state = migrateState(v2, ctx);
    expect(state.schemaVersion).toBe(3);
    expect(state.reviewSession).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The game: capture on QA pass, automatic checkout and return

const localSource = () =>
  new LocalContentSource({
    repoPath: resolve(root, '..', 'supportdesk-private'),
    manifestPath: join(root, 'build', 'stage-packages', 'manifest.json'),
    runner: runCommand,
  });

function createGame(runtime = new FakeRuntime(JSON.stringify({ qaDelayMs: 1, qa: ['passed'] }))) {
  const game = new Game({
    store: new StateStore(dir),
    packages: new PackageStore(join(dir, 'packages')),
    reviews: new ReviewStore(join(dir, 'reviews')),
    review: loadReviewConfig('supportdesk'),
    content: localSource(),
    runtime,
    appVersion: '0.1.0',
    versions: { electron: 'test', node: process.versions.node, chrome: 'test' },
  });
  return { game, runtime };
}

async function passQa(game: Game, ticket = 1) {
  await game.nextAssignment();
  await game.move(ticket, 'inProgress');
  await game.move(ticket, 'inQa');
  await game.waitForQa();
  expect(rules.findTicket(game.current, ticket)!.status).toBe('codeReview');
}

describe('code review in the game', () => {
  it('stores the approved snapshot without excluded files and builds the review branch from it', async () => {
    const { game, runtime } = createGame();
    await game.init();
    await passQa(game);
    const [build] = runtime.builds;
    expect(build.ticket).toBe(1);
    expect(build.snapshot.map((file) => file.path)).toEqual(['client/src/App.tsx']); // package-lock.json left out
    expect(build.messages.snapshot).toBe('Your approved solution — ticket 1');
    expect(JSON.parse(build.settings)['files.readonlyInclude']).toEqual({ '**': true });
    expect(build.excludes).toContain(':(exclude,glob)**/node_modules/**');
    expect((await game.reviewComparison(1)).solutions).toContain('TicketDetails.tsx');
  });

  it('opens the review and brings the player code back, recording each step', async () => {
    const { game, runtime } = createGame();
    await game.init();
    await passQa(game);
    runtime.wipCommit = sha('d');
    await game.openReview(1);
    expect(game.current.reviewSession).toMatchObject({ ticket: 1, phase: 'open', wipCommit: sha('d') });
    expect(await runtime.currentBranch()).toBe('review/ticket-1');
    await game.closeReview();
    expect(game.current.reviewSession).toBeNull();
    expect(await runtime.currentBranch()).toBe('player/ticket-1');
    expect(runtime.returns[0]).toMatchObject({ ticket: 1, wipCommit: sha('d') });
  });

  it('rolls back to the player code when the checkout fails', async () => {
    const { game, runtime } = createGame();
    await game.init();
    await passQa(game);
    runtime.failSwitch = true;
    await expect(game.openReview(1)).rejects.toMatchObject({ code: 'reviewFailed' });
    expect(game.current.reviewSession).toBeNull();
    expect(runtime.returns).toHaveLength(1);
  });

  it.each([
    ['Open in VS Code', async (game: Game) => game.openVSCode()],
    ['accepting the review', async (game: Game) => game.acceptReview(1)],
    ['exporting', async (game: Game) => game.exportProgress(join(dir, 'save.bdsave'))],
    ['starting a new game', async (game: Game) => game.newGame()],
  ])('returns to the player code before %s', async (_name, action) => {
    const { game, runtime } = createGame();
    await game.init();
    await passQa(game);
    await game.openReview(1);
    await action(game);
    expect(runtime.returns).toHaveLength(1);
    expect(game.current.reviewSession).toBeNull();
  });

  it('opens the review of a Done ticket from the current ticket, and returns there before starting it and before QA', async () => {
    const { game, runtime } = createGame(new FakeRuntime(JSON.stringify({ qaDelayMs: 1, qa: ['passed', 'passed'] })));
    await game.init();
    await passQa(game, 1);
    await game.acceptReview(1);
    await game.nextAssignment();

    await game.openReview(1);
    expect(game.current.reviewSession?.returnPoint.branch).toBe('player/ticket-2');
    expect(await runtime.currentBranch()).toBe('review/ticket-1');
    await game.move(2, 'inProgress'); // the workspace reset of a new ticket
    expect(await runtime.currentBranch()).toBe('player/ticket-2');
    expect(runtime.resets).toEqual([1, 2]);

    await game.openReview(1);
    await game.move(2, 'inQa');
    expect(runtime.returns).toHaveLength(2);
    expect(game.current.reviewSession).toBeNull();
    await game.waitForQa();
    expect(rules.findTicket(game.current, 2)!.status).toBe('codeReview');
  });

  it('after a crash, brings the player code back once Docker answers', async () => {
    const first = createGame();
    await first.game.init();
    await passQa(first.game);
    await first.game.openReview(1);

    const { game, runtime } = createGame();
    await game.init();
    expect(game.current.reviewSession?.phase).toBe('open');
    await game.refreshDockerState();
    await expect.poll(() => game.current.reviewSession).toBeNull();
    expect(runtime.returns[0]).toMatchObject({ ticket: 1, point: { branch: 'player/ticket-1' } });
  });

  it('after a crash while saving, recognizes the temporary commit only if it is HEAD on top of the player commit', async () => {
    const first = createGame();
    await first.game.init();
    await passQa(first.game);
    await first.game.openReview(1);
    const session = first.game.current.reviewSession!;
    await new StateStore(dir).save({ ...first.game.current, reviewSession: { ...session, phase: 'saving', wipCommit: null } });

    const { game, runtime } = createGame();
    runtime.headInfo = { commit: sha('e'), parent: session.returnPoint.head, subject: WIP_MESSAGE };
    await game.init();
    await game.refreshDockerState();
    await expect.poll(() => runtime.returns.length).toBe(1);
    expect(runtime.returns[0].wipCommit).toBe(sha('e'));
  });

  it('rebuilds a missing review branch from the stored data before opening it', async () => {
    const { game, runtime } = createGame();
    await game.init();
    await passQa(game);
    runtime.reviews.clear();
    await game.openReview(1);
    expect(runtime.builds).toHaveLength(2);
    expect(runtime.builds[1].snapshot).toEqual(runtime.builds[0].snapshot);
    expect(runtime.builds[1].date).toBe(runtime.builds[0].date);
  });

  it('applies the same technique to any project through its configuration only', async () => {
    const { game, runtime } = createGame();
    (game as unknown as { options: { review: unknown } }).options.review = parseReviewConfig({ exclude: ['client/**'] });
    await game.init();
    await passQa(game);
    expect(runtime.builds[0].snapshot).toEqual([]);
    expect(runtime.builds[0].excludes).toContain(':(exclude,glob)client/**');
  });
});
