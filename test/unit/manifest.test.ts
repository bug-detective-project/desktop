import { describe, expect, it } from 'vitest';
import { ContentVerificationError, parseManifest, ticketAt } from '../../src/main/services/content/manifest.ts';

const digest = (char: string) => `sha256:${char.repeat(64)}`;

function entry(track: 'front' | 'back', order: number) {
  const id = `${track}-${order}`;
  return {
    id,
    track,
    order,
    branch: id,
    tag: `${id}-v1.0.0`,
    commit: 'a'.repeat(40),
    commitMessage: `Project release ${id}`,
    codeDigest: digest('b'),
    codeFiles: 10,
    package: { path: `tickets/${id}`, files: 12, digest: digest('c') },
  };
}

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    format: 'bug-detective-project',
    formatVersion: 1,
    project: { id: 'supportdesk', name: 'SupportDesk' },
    version: '1.0.0',
    createdAt: '2026-11-02T10:00:00.000Z',
    tickets: { total: 3, front: 2, back: 1 },
    entries: [entry('front', 1), entry('front', 2), entry('back', 1)],
    ...overrides,
  };
}

describe('project manifest', () => {
  it('accepts a valid manifest', () => {
    expect(parseManifest(manifest(), 'supportdesk').tickets.total).toBe(3);
  });

  it('rejects a manifest of another project', () => {
    expect(() => parseManifest(manifest(), 'other')).toThrow(/another project/);
  });

  it('rejects a total that is not front + back', () => {
    expect(() => parseManifest(manifest({ tickets: { total: 4, front: 2, back: 1 } }))).toThrow(/total/);
  });

  it('rejects counts that do not match the entries', () => {
    expect(() => parseManifest(manifest({ tickets: { total: 4, front: 3, back: 1 } }))).toThrow(/front/);
  });

  it('rejects a gap in a track order', () => {
    const entries = [entry('front', 1), entry('front', 3), entry('back', 1)];
    expect(() => parseManifest(manifest({ entries }))).toThrow(/order/);
  });

  it('rejects a repeated order', () => {
    const entries = [entry('front', 1), entry('front', 1), entry('back', 1)];
    expect(() => parseManifest(manifest({ entries }))).toThrow(/order/);
  });

  it('rejects an id that is not track-order', () => {
    const entries = [entry('front', 1), { ...entry('front', 2), id: 'front-9' }, entry('back', 1)];
    expect(() => parseManifest(manifest({ entries }))).toThrow(/id/);
  });

  it('rejects back tickets before front tickets', () => {
    const entries = [entry('back', 1), entry('front', 1), entry('front', 2)];
    expect(() => parseManifest(manifest({ entries }))).toThrow(/order/);
  });

  it('rejects a project without tickets', () => {
    expect(() => parseManifest(manifest({ tickets: { total: 0, front: 0, back: 0 }, entries: [] }))).toThrow(ContentVerificationError);
  });

  it('rejects an invalid project id', () => {
    expect(() => parseManifest(manifest({ project: { id: 'Support Desk', name: 'SupportDesk' } }))).toThrow(ContentVerificationError);
  });

  it('rejects a package path outside tickets/<id>', () => {
    const entries = [entry('front', 1), { ...entry('front', 2), package: { ...entry('front', 2).package, path: 'tickets/front-1' } }, entry('back', 1)];
    expect(() => parseManifest(manifest({ entries }))).toThrow(/path/);
  });

  it('finds a ticket by its queue position', () => {
    const parsed = parseManifest(manifest());
    expect(ticketAt(parsed, 3).id).toBe('back-1');
    expect(() => ticketAt(parsed, 4)).toThrow(ContentVerificationError);
  });
});
