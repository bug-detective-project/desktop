import { describe, expect, it } from 'vitest';
import { createSave, InvalidSaveError, readSave, signManifest } from '../../src/main/services/backup.ts';
import { readZip, sha256Hex, textFile, writeZip } from '@bug-detective/catalog/contract';
import * as rules from '../../src/shared/kanban.ts';
import { unlocked } from '../helpers/tickets.ts';

const ctx = { now: '2026-10-26T10:00:00.000Z', id: (() => { let n = 0; return () => `00000000-0000-4000-8000-${String((n += 1)).padStart(12, '0')}`; })() };
const bundle = new Uint8Array(Buffer.from('# v2 git bundle\n'));
const KEY = new Uint8Array(Buffer.from('11'.repeat(32), 'hex'));
const OTHER_KEY = new Uint8Array(Buffer.from('22'.repeat(32), 'hex'));
const packageZip = writeZip([textFile('ticket.en.md', '# SD-214\n')]);

function progress() {
  let state = rules.unlockTicket(rules.createInitialState(ctx), 1, unlocked(1, 'a'.repeat(40)), ctx);
  state = rules.playerMove(state, 1, 'inProgress', ctx);
  return state;
}

function rebuild(save: Uint8Array, change: (files: ReturnType<typeof readZip>) => ReturnType<typeof readZip>) {
  return writeZip(change(readZip(save)));
}

describe('export and restore manifest', () => {
  const state = progress();
  const save = createSave({ state, bundle, packages: new Map([[1, packageZip]]) }, '0.1.0', ctx.now, KEY);

  it('refuses a save whose game state disagrees with the Kanban rules', () => {
    const broken = createSave({ state: { ...state, currentTicket: 3 }, bundle, packages: new Map([[1, packageZip]]) }, '0.1.0', ctx.now, KEY);
    expect(() => readSave(broken, KEY)).toThrow(InvalidSaveError);
    expect(() => readSave(broken, KEY)).toThrow(/current ticket must be 1/);
  });

  it('refuses to create a save larger than a restore accepts', () => {
    expect(() => createSave({ state, bundle, packages: new Map([[1, packageZip]]) }, '0.1.0', ctx.now, KEY, 100)).toThrow(/larger than 100 bytes/);
  });

  it('round-trips state, bundle and packages', () => {
    const restored = readSave(save, KEY);
    expect(restored.state).toEqual(state);
    expect(Buffer.from(restored.bundle!).toString()).toBe('# v2 git bundle\n');
    expect(sha256Hex(restored.packages.get(1)!)).toBe(sha256Hex(packageZip));
    expect(restored.manifest).toMatchObject({ format: 'bug-detective-save', formatVersion: 5, appVersion: '0.1.0', schemaVersion: 8 });
    expect(Object.keys(restored.manifest.files).sort()).toEqual(['packages/stage-1.zip', 'state.json', 'workspace.bundle']);
  });

  it('tells a save made by this installation from one made elsewhere, and refuses a manifest without a signature', () => {
    expect(readSave(save, KEY).fromThisInstall).toBe(true);
    expect(readSave(save, OTHER_KEY).fromThisInstall).toBe(false);
    const edit = (change: (manifest: Record<string, unknown>) => Record<string, unknown>) =>
      rebuild(save, (files) => files.map((file) => (file.path === 'manifest.json' ? textFile('manifest.json', JSON.stringify(change(JSON.parse(Buffer.from(file.data).toString())))) : file)));
    // A forged signature is just a foreign save; a missing or malformed one is not a save of this format.
    expect(readSave(edit((manifest) => ({ ...manifest, hmac: 'ab'.repeat(32) })), KEY).fromThisInstall).toBe(false);
    expect(() => readSave(edit(({ hmac: _hmac, ...rest }) => rest), KEY)).toThrow(/manifest is invalid/);
    expect(() => readSave(edit((manifest) => ({ ...manifest, hmac: 'short' })), KEY)).toThrow(/manifest is invalid/);
    // The signature covers the whole manifest: a changed field (with its checksum kept right) no longer matches.
    const manifest = JSON.parse(Buffer.from(readZip(save).find((file) => file.path === 'manifest.json')!.data).toString()) as Record<string, unknown>;
    expect(signManifest({ ...manifest, createdAt: '2026-10-27T10:00:00.000Z' } as never, KEY)).not.toBe(manifest.hmac);
    expect(signManifest(manifest as never, KEY)).toBe(manifest.hmac);
  });

  it('rejects files that are not saves', () => {
    expect(() => readSave(new Uint8Array(Buffer.from('hello')), KEY)).toThrow(InvalidSaveError);
    expect(() => readSave(writeZip([textFile('readme.txt', 'x')]), KEY)).toThrow(/no manifest/);
  });

  it('rejects a manifest with the wrong format or a newer schema', () => {
    const edit = (patch: Record<string, unknown>) =>
      rebuild(save, (files) =>
        files.map((file) =>
          file.path === 'manifest.json'
            ? textFile('manifest.json', JSON.stringify({ ...JSON.parse(Buffer.from(file.data).toString()), ...patch }))
            : file,
        ),
      );
    expect(() => readSave(edit({ format: 'something-else' }), KEY)).toThrow(/manifest is invalid/);
    expect(() => readSave(edit({ formatVersion: 4 }), KEY)).toThrow(/older, unsupported|manifest is invalid/);
    expect(() => readSave(edit({ schemaVersion: 99 }), KEY)).toThrow(/newer version/);
    expect(() => readSave(edit({ schemaVersion: 5 }), KEY)).toThrow(/older, unsupported/);
  });

  it('rejects damaged or unexpected entries', () => {
    const damaged = rebuild(save, (files) => files.map((file) => (file.path === 'workspace.bundle' ? textFile(file.path, 'changed') : file)));
    expect(() => readSave(damaged, KEY)).toThrow(/workspace.bundle does not match/);
    const missing = rebuild(save, (files) => files.filter((file) => file.path !== 'packages/stage-1.zip'));
    expect(() => readSave(missing, KEY)).toThrow(/packages\/stage-1.zip does not match/);
    const extra = rebuild(save, (files) => [...files, textFile('evil.sh', 'rm -rf /')]);
    expect(() => readSave(extra, KEY)).toThrow(/unexpected file/);
  });

  it('rejects a save whose state is invalid or inconsistent', () => {
    const badState = createSave({ state: { ...progress(), currentTicket: 'one' } as never, bundle, packages: new Map([[1, packageZip]]) }, '0.1.0', ctx.now, KEY);
    expect(() => readSave(badState, KEY)).toThrow(/state is invalid/);
    const noBundle = createSave({ state: progress(), bundle: null, packages: new Map([[1, packageZip]]) }, '0.1.0', ctx.now, KEY);
    expect(() => readSave(noBundle, KEY)).toThrow(/no workspace repository/);
    const noPackage = createSave({ state: progress(), bundle, packages: new Map() }, '0.1.0', ctx.now, KEY);
    expect(() => readSave(noPackage, KEY)).toThrow(/missing the package for ticket 1/);
  });

  it('accepts a save of a new game without a repository', () => {
    const empty = createSave({ state: rules.createInitialState(ctx), bundle: null, packages: new Map() }, '0.1.0', ctx.now, KEY);
    expect(readSave(empty, KEY).bundle).toBeNull();
  });
});

describe('save size when extracted', () => {
  it('refuses a save that would be too large when extracted, with the reason', () => {
    const zip = new Uint8Array(writeZip([textFile('state.json', '{}')]));
    const view = new DataView(zip.buffer);
    const central = zip.findIndex((_, index) => index + 4 <= zip.length && view.getUint32(index, true) === 0x02014b50);
    view.setUint32(central + 24, 0xf0000000, true);
    expect(() => readSave(zip, KEY)).toThrow(InvalidSaveError);
    expect(() => readSave(zip, KEY)).toThrow(/too large when extracted/);
  });
});

describe('saves with several projects', () => {
  it('carries the packages and PRs of the other projects, keyed by project', () => {
    const away = rules.beginSwitch(progressDone(), 'first', 'second', ctx);
    const state = rules.finishSwitch(away);
    const reviewFiles = new Map([['reviews/ticket-1/review.json', new Uint8Array(Buffer.from('{}'))], ['reviews/ticket-1/snapshot.diff', new Uint8Array(Buffer.from('diff'))]]);
    const save = createSave(
      { state, bundle, packages: new Map(), others: new Map([['first', { packages: new Map([[1, packageZip]]), reviews: reviewFiles }]]) },
      '0.1.0',
      ctx.now,
      KEY,
    );
    expect(readZip(save).map((file) => file.path).filter((path) => path.startsWith('projects/')).sort()).toEqual([
      'projects/first/packages/stage-1.zip',
      'projects/first/reviews/ticket-1/review.json',
      'projects/first/reviews/ticket-1/snapshot.diff',
    ]);
    const restored = readSave(save, KEY);
    expect(sha256Hex(restored.others.get('first')!.packages.get(1)!)).toBe(sha256Hex(packageZip));
    expect([...restored.others.get('first')!.reviews.keys()].sort()).toEqual(['reviews/ticket-1/review.json', 'reviews/ticket-1/snapshot.diff']);
  });

  it('refuses a save whose other project misses the package of a ticket', () => {
    const state = rules.finishSwitch(rules.beginSwitch(progressDone(), 'first', 'second', ctx));
    expect(() => readSave(createSave({ state, bundle, packages: new Map() }, '0.1.0', ctx.now, KEY), KEY)).toThrow(/first.*ticket 1/);
  });
});

function progressDone() {
  let state = progress();
  state = rules.playerMove(state, 1, 'inQa', ctx);
  const result = { ticket: 1, gate: 2 as const, status: 'passed' as const, message: '', tests: [], durationMs: 1 };
  state = rules.recordQaResult(state, 1, { startedAt: ctx.now, branch: 'player/ticket-1', branchWarning: false, timeoutSeconds: 180, result }, ctx);
  return rules.acceptReview(state, 1, ctx);
}
