/**
 * window.bugDetective for the stories: every method exists. A method a story sets in
 * parameters.api answers as the story wants; any other one is recorded and resolves with a
 * default (snapshot() with the story's snapshot, onSnapshot() with an unsubscribe), so a story never
 * breaks on an API call it did not plan for. The reads the screens make on their own (ticket
 * content, review comparison, workspace, prerequisites, environment, disk usage) answer with the
 * stories' data.
 */
import type { BugDetectiveApi, Snapshot } from '@shared/api.ts';
import { reviewComparisonFixture, snapshotFixture, ticketContentFixture } from './fixtures.ts';

export type ApiOverrides = Partial<BugDetectiveApi>;
export interface ApiCall {
  method: string;
  args: unknown[];
}

const current: { overrides: ApiOverrides; calls: ApiCall[]; snapshot: Snapshot | null } = { overrides: {}, calls: [], snapshot: null };

export const fakeApi = new Proxy({} as BugDetectiveApi, {
  get(_target, method) {
    // Not a thenable: awaiting the API object itself must not call a method.
    if (typeof method !== 'string' || method === 'then') {
      return undefined;
    }
    return (...args: unknown[]) => {
      current.calls.push({ method, args });
      const override = current.overrides[method as keyof BugDetectiveApi] as ((...input: unknown[]) => unknown) | undefined;
      if (override) {
        return override(...args);
      }
      const snapshot = current.snapshot ?? snapshotFixture();
      const reads: Record<string, () => unknown> = {
        snapshot: () => snapshot,
        ticketContent: () => ticketContentFixture(),
        reviewComparison: () => reviewComparisonFixture(),
        workspaceStatus: () => ({ ports: { client: 5173, api: 3001 }, devServerUp: false, branch: 'player/ticket-1' }),
        checkPrerequisites: () => snapshot.prerequisites,
        refreshEnvironment: () => snapshot.environment,
        diskUsage: () => [],
      };
      if (reads[method]) {
        return Promise.resolve(reads[method]());
      }
      if (method === 'onSnapshot') {
        return () => {};
      }
      return Promise.resolve(undefined);
    };
  },
});

/** Called before each story: its overrides and snapshot, and an empty call log. */
export function installFakeApi(overrides: ApiOverrides = {}, snapshot: Snapshot | null = null): void {
  current.overrides = overrides;
  current.calls = [];
  current.snapshot = snapshot;
}

/** The API calls made since the story started, in order. */
export function apiCalls(): ApiCall[] {
  return current.calls;
}
