/**
 * Game state persistence: one versioned JSON file in the app data folder, written atomically
 * (temp file + rename) and validated before use. Only the current schema is read: an older file
 * is kept aside and a new game starts (the app has not shipped, so there is nothing to migrate).
 */
import { readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { createInitialState } from '../../shared/kanban.ts';
import type { RuleContext } from '../../shared/kanban.ts';
import {
  COLUMNS,
  LANGUAGES,
  MAX_QA_TIMEOUT_SECONDS,
  MIN_QA_TIMEOUT_SECONDS,
  SCHEMA_VERSION,
  THEMES,
  TRACKS,
  TRACK_CHOICES,
} from '../../shared/types.ts';
import type { GameState } from '../../shared/types.ts';
import { writeFileAtomic } from './content/store.ts';

const column = z.enum(COLUMNS);
const testRecord = z.object({
  name: z.string(),
  status: z.enum(['passed', 'failed', 'skipped', 'unfinished']),
  error: z.string().optional(),
});

const ticketSchema = z.object({
  ticket: z.number().int().min(1),
  id: z.string().regex(/^(front|back)-[1-9][0-9]?$/),
  track: z.enum(TRACKS),
  manifestVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  status: column,
  unlockedAt: z.string(),
  stageCommit: z.string().nullable(),
  attempts: z.array(
    z.object({
      id: z.string(),
      number: z.number().int(),
      startedAt: z.string(),
      finishedAt: z.string(),
      branch: z.string().nullable(),
      branchWarning: z.boolean(),
      timeoutSeconds: z.number(),
      result: z.object({
        ticket: z.number().int(),
        gate: z.union([z.literal(1), z.literal(2)]),
        status: z.enum(['passed', 'failed', 'timeout', 'outOfMemory']),
        message: z.string(),
        tests: z.array(testRecord),
        durationMs: z.number(),
      }),
    }),
  ),
  comments: z.array(
    z.object({
      id: z.string(),
      at: z.string(),
      kind: z.enum(['gate1Failed', 'gate2Failed', 'timeout', 'outOfMemory', 'passed', 'interrupted', 'error', 'branchWarning']),
      attemptId: z.string().optional(),
      failing: z.array(z.object({ name: z.string(), error: z.string().optional() })).optional(),
      unfinished: z.array(z.string()).optional(),
      timeoutSeconds: z.number().optional(),
      detail: z.string().optional(),
      branch: z.string().nullable().optional(),
    }),
  ),
  hintsRevealed: z.number().int().min(0),
  solutionRevealed: z.boolean(),
  reviewAcceptedAt: z.string().nullable(),
  qaStartedAt: z.string().nullable(),
  playerDiff: z.string().nullable(),
  conversation: z.array(
    z.object({
      at: z.string(),
      from: z.enum(['player', 'senior']),
      kind: z.enum(['question', 'hint', 'solutionRequest', 'solution']),
      hintIndex: z.number().int().optional(),
    }),
  ),
});

const activitySchema = z.object({
  ticket: z.number().int(),
  from: column.nullable(),
  to: column,
  at: z.string(),
  actor: z.enum(['player', 'system']),
  reason: z
    .enum(['unlocked', 'started', 'submitted', 'qaPassed', 'qaFailed', 'qaTimeout', 'qaInterrupted', 'qaError', 'reviewAccepted'])
    .optional(),
});

const inboxSchema = z.object({
  id: z.string(),
  kind: z.enum(['welcome', 'assignment', 'completion', 'trackCompletion']),
  track: z.enum(TRACK_CHOICES).optional(),
  ticket: z.number().int().optional(),
  at: z.string(),
  read: z.boolean(),
});

const projectProgressSchema = z.object({
  createdAt: z.string(),
  tracks: z.object({ front: z.number().int().min(0), back: z.number().int().min(0) }).nullable(),
  tickets: z.array(ticketSchema),
  activity: z.array(activitySchema),
  inbox: z.array(inboxSchema),
});

export const gameStateSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  project: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/).nullable(),
  otherProjects: z.record(z.string().regex(/^[a-z][a-z0-9-]{0,39}$/), projectProgressSchema),
  projectSources: z.record(
    z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
    z.object({
      repository: z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/),
      qaRef: z.string().min(1).max(100),
      minVersion: z.string().regex(/^\d+\.\d+\.\d+$/).nullable(),
    }),
  ),
  projectSwitch: z
    .object({ from: z.string(), to: z.string(), phase: z.literal('cleaning'), startedAt: z.string() })
    .nullable(),
  createdAt: z.string(),
  currentTicket: z.number().int().nullable(),
  tracks: z.object({ front: z.number().int().min(0), back: z.number().int().min(0) }).nullable(),
  tickets: z.array(ticketSchema),
  activity: z.array(activitySchema),
  inbox: z.array(inboxSchema),
  settings: z.object({
    language: z.enum(LANGUAGES),
    // The minimum was 30 s before it became 1 minute: older states and saves load with 1 minute.
    qaTimeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(MAX_QA_TIMEOUT_SECONDS)
      .transform((seconds) => Math.max(MIN_QA_TIMEOUT_SECONDS, seconds)),
    theme: z.enum(THEMES),
  }),
  lastExport: z.object({ at: z.string(), path: z.string() }).nullable().optional(),
  onboardingSeen: z.boolean().optional(),
  reviewSession: z
    .object({
      ticket: z.number().int().min(1),
      phase: z.enum(['saving', 'switching', 'open', 'returning']),
      startedAt: z.string(),
      returnPoint: z.object({
        branch: z.string().nullable(),
        head: z.string().regex(/^[0-9a-f]{40,64}$/),
        indexTree: z.string().regex(/^[0-9a-f]{40,64}$/),
        excludesFile: z.string().nullable(),
      }),
      wipCommit: z
        .string()
        .regex(/^[0-9a-f]{40,64}$/)
        .nullable(),
    })
    .nullable(),
})
  // The fields agree with each other as the Kanban rules leave them: tickets are unlocked one after
  // another, the last one is the active one, and only it may be unfinished. A hand-edited state or
  // save that breaks this is invalid, rather than loaded into a game the rules cannot handle.
  .superRefine((state, ctx) => {
    const issue = (message: string, path: (string | number)[]) => ctx.addIssue({ code: 'custom', message, path });
    if (state.tracks === null && state.tickets.length > 0) {
      issue('Unlocked tickets need the track counts', ['tracks']);
    }
    const ids = new Set<string>();
    state.tickets.forEach((ticket, index) => {
      const [track, order] = ticket.id.split('-');
      if (track !== ticket.track) {
        issue(`Ticket ${ticket.id} belongs to the ${track} track`, ['tickets', index, 'track']);
      } else if (state.tracks && Number(order) > state.tracks[ticket.track]) {
        issue(`Ticket ${ticket.id} is not one of the ${state.tracks[ticket.track]} ${ticket.track} tickets`, ['tickets', index, 'id']);
      }
      if (ids.has(ticket.id)) {
        issue(`Ticket ${ticket.id} is unlocked twice`, ['tickets', index, 'id']);
      }
      ids.add(ticket.id);
    });
    state.tickets.forEach((ticket, index) => {
      if (ticket.ticket !== index + 1) {
        issue(`Ticket ${index + 1} expected, found ${ticket.ticket}`, ['tickets', index, 'ticket']);
      } else if (index < state.tickets.length - 1 && ticket.status !== 'done') {
        issue(`Ticket ${ticket.ticket} is not the last one, so it must be done`, ['tickets', index, 'status']);
      }
    });
    const last = state.tickets.at(-1)?.ticket ?? null;
    if (state.currentTicket !== last) {
      issue(`The current ticket must be ${last ?? 'none'}, not ${state.currentTicket ?? 'none'}`, ['currentTicket']);
    }
    if (state.reviewSession && !state.tickets.some((ticket) => ticket.ticket === state.reviewSession!.ticket)) {
      issue(`The review is for ticket ${state.reviewSession.ticket}, which is not unlocked`, ['reviewSession', 'ticket']);
    }
  });

export class StateVersionError extends Error {}

/** Validates raw JSON of the current schema. Any other schema version is a StateVersionError. */
export function parseState(raw: unknown): GameState {
  const version = Number((raw as { schemaVersion?: unknown } | null)?.schemaVersion);
  if (!Number.isInteger(version) || version < 1) {
    throw new StateVersionError('The saved game has no schema version');
  }
  if (version > SCHEMA_VERSION) {
    throw new StateVersionError(`The saved game was created by a newer version of Bug Detective (schema ${version})`);
  }
  if (version < SCHEMA_VERSION) {
    throw new StateVersionError(`The saved game was made by an older, unsupported version of Bug Detective (schema ${version})`);
  }
  return gameStateSchema.parse(raw) as GameState;
}

export class StateStore {
  readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string) {
    this.file = join(dir, 'state.json');
  }

  /**
   * Loads the saved game. A missing file starts a new game; an unreadable one, or one of an older
   * schema, is kept aside as state.corrupt-<time>.json and a new game starts.
   */
  async load(ctx: RuleContext, language: 'en' | 'pt' = 'en'): Promise<{ state: GameState; recovered: boolean }> {
    let text: string;
    try {
      text = await readFile(this.file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { state: createInitialState(ctx, language), recovered: false };
      }
      throw error;
    }
    try {
      const state = parseState(JSON.parse(text));
      return { state, recovered: false };
    } catch (error) {
      if (error instanceof StateVersionError && /newer version/.test(error.message)) {
        throw error;
      }
      await rename(this.file, join(this.file, '..', `state.corrupt-${Date.now()}.json`));
      return { state: createInitialState(ctx, language), recovered: true };
    }
  }

  /** Saves atomically. Writes are serialized, so the last save always wins. */
  save(state: GameState): Promise<void> {
    const write = this.queue.then(() => writeFileAtomic(this.file, `${JSON.stringify(state, null, 2)}\n`));
    this.queue = write.catch(() => {});
    return write;
  }
}
