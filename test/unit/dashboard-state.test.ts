import { describe, expect, it } from 'vitest';
import type { EnvironmentReport, Snapshot } from '../../src/shared/api.ts';
import type { TicketState } from '../../src/shared/types.ts';
import { deskState, environmentRows, environmentSummary, inboxMessageText } from '../../src/renderer/src/screens/dashboardState.ts';

const READY: EnvironmentReport = {
  items: [
    { id: 'workspaceImage', ready: true },
    { id: 'qaImage', ready: true },
    { id: 'projectDependencies', ready: true },
  ],
  ready: true,
};

/** Only the fields the Dashboard state reads. */
function snapshot(overrides: Partial<Snapshot> = {}, inbox: { kind: string }[] = []): Snapshot {
  return {
    state: { inbox, settings: { language: 'en' } },
    nextTicket: null,
    busy: null,
    dockerState: 'running',
    environment: READY,
    ...overrides,
  } as unknown as Snapshot;
}

const active = { ticket: 1, status: 'inProgress' } as TicketState;
// The key itself: enough to check which status a row shows.
const t = (key: string) => key;

describe('deskState', () => {
  it('shows the downloads first, also while they install and over an active ticket', () => {
    const missing = { ...READY, ready: false, items: [{ id: 'workspaceImage' as const, ready: false }] };
    expect(deskState(snapshot({ environment: missing }), active)).toBe('download');
    expect(deskState(snapshot({ busy: 'installing' }), active)).toBe('download');
  });

  it('shows the unlock in progress before anything else but the downloads', () => {
    expect(deskState(snapshot({ busy: 'unlocking', nextTicket: 2 }), undefined)).toBe('unlocking');
  });

  it('shows the active ticket', () => {
    expect(deskState(snapshot({ nextTicket: null }), active)).toBe('active');
  });

  it('shows the queued next assignment, or Docker to start first', () => {
    expect(deskState(snapshot({ nextTicket: 2 }), undefined)).toBe('queued');
    expect(deskState(snapshot({ nextTicket: 2, dockerState: 'notRunning' }), undefined)).toBe('dockerDown');
    expect(deskState(snapshot({ nextTicket: 2, dockerState: null }), undefined)).toBe('dockerDown');
  });

  it('shows the end of the sprint, or nothing before the first message', () => {
    expect(deskState(snapshot({}, [{ kind: 'welcome' }, { kind: 'completion' }]), undefined)).toBe('allDone');
    expect(deskState(snapshot({ environment: null }), undefined)).toBe('none');
  });
});

describe('environmentRows', () => {
  const tones = (rows: ReturnType<typeof environmentRows>) => Object.fromEntries(rows.map((row) => [row.id, row.tone]));

  it('always lists Docker and the three downloads, with a status word and the size when ready', () => {
    const rows = environmentRows(snapshot(), t);
    expect(rows.map((row) => row.id)).toEqual(['docker', 'workspaceImage', 'qaImage', 'projectDependencies']);
    expect(rows[1].status).toBe('dashboard.envStatus.ready · 1.1 GB');
    expect(environmentSummary(rows)).toBe('ok');
  });

  it('writes the size the Portuguese way', () => {
    const pt = snapshot();
    (pt.state.settings as { language: string }).language = 'pt';
    expect(environmentRows(pt, t)[1].status).toBe('dashboard.envStatus.ready · 1,1 GB');
  });

  it('is warn while Docker starts or the downloads install, with a spinner', () => {
    const starting = environmentRows(snapshot({ busy: 'startingDocker' }), t);
    expect(starting[0]).toMatchObject({ tone: 'warn', status: 'dashboard.envStatus.starting', busy: true });
    expect(environmentSummary(starting)).toBe('warn');

    const missing = { items: [{ id: 'workspaceImage' as const, ready: false }, { id: 'qaImage' as const, ready: false }], ready: false };
    const installing = environmentRows(snapshot({ busy: 'installing', environment: missing }), t);
    expect(tones(installing)).toMatchObject({ workspaceImage: 'warn', qaImage: 'warn' });
    expect(installing[1].busy).toBe(true);
    expect(environmentSummary(installing)).toBe('warn');
  });

  it('is danger when Docker is stopped or a download is missing', () => {
    const stopped = environmentRows(snapshot({ dockerState: 'notRunning', environment: null }), t);
    expect(stopped[0]).toMatchObject({ tone: 'danger', status: 'dashboard.envStatus.notRunning' });
    // Without Docker the downloads cannot be checked: neutral, with a word.
    expect(stopped[1]).toMatchObject({ tone: 'neutral', status: 'dashboard.envStatus.needsDocker' });
    expect(environmentSummary(stopped)).toBe('danger');

    const missing = { items: [{ id: 'workspaceImage' as const, ready: false }, { id: 'qaImage' as const, ready: true }], ready: false };
    const rows = environmentRows(snapshot({ environment: missing }), t);
    expect(rows[1]).toMatchObject({ tone: 'danger', status: 'dashboard.envStatus.missing' });
    expect(environmentSummary(rows)).toBe('danger');
  });

  it('does not count dependencies that come with the first ticket as missing', () => {
    const beforeFirst = { items: [{ id: 'workspaceImage' as const, ready: true }, { id: 'qaImage' as const, ready: true }], ready: true };
    const rows = environmentRows(snapshot({ environment: beforeFirst }), t);
    expect(rows[3]).toMatchObject({ tone: 'neutral', status: 'dashboard.envStatus.notYet' });
    expect(environmentSummary(rows)).toBe('ok');
  });
});

describe('inbox message text', () => {
  const messages = {
    welcome: { subject: 'Welcome', body: 'Hi' },
    completion: { subject: 'Done', body: 'Thanks' },
    trackCompletion: { subject: 'The {{track}} track is done', body: 'All {{track}} tickets closed.' },
    assignments: { 'back-1': { subject: 'First back ticket', body: 'Go' } },
  };
  const fallback = { subject: 'Your next ticket', body: 'On the Board.' };
  const message = (kind: 'welcome' | 'assignment' | 'completion' | 'trackCompletion', ticket?: number) => ({ id: 'm', kind, ticket, at: '', read: false });
  const idOf = (ticket: number) => (ticket === 1 ? 'back-1' : undefined);

  it('uses the story message of each kind, assignments by ticket id', () => {
    expect(inboxMessageText(messages, message('welcome'), fallback, idOf).subject).toBe('Welcome');
    expect(inboxMessageText(messages, message('completion'), fallback, idOf).subject).toBe('Done');
    expect(inboxMessageText(messages, message('assignment', 1), fallback, idOf).subject).toBe('First back ticket');
  });

  it('names the track in the project completion too', () => {
    const story = { ...messages, completion: { subject: 'Project done', body: 'You completed the {{track}} track.' } };
    const done = { ...message('completion'), track: 'back' as const };
    expect(inboxMessageText(story, done, fallback, idOf).body).toBe('You completed the back track.');
  });

  it('names the completed track in a track completion', () => {
    const done = { ...message('trackCompletion'), track: 'fullstack' as const };
    expect(inboxMessageText(messages, done, fallback, idOf)).toEqual({ subject: 'The fullstack track is done', body: 'All fullstack tickets closed.' });
  });

  it('falls back to a generic assignment when the story has none for the ticket', () => {
    expect(inboxMessageText(messages, message('assignment', 5), fallback, idOf)).toEqual(fallback);
  });
});
