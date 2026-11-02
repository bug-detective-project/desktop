/**
 * The project manifest: manifest.json at the root of a project's qa branch, written by
 * publish:project (services/content/publish.ts) and checked by every content source.
 */
import { z } from 'zod';

export const TRACKS = ['front', 'back'] as const;
export type Track = (typeof TRACKS)[number];

/** A ticket id: its track and its order in the track, also the name of its branch and folder. */
export const TICKET_ID = /^(front|back)-([1-9][0-9]?)$/;

const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const ticketEntrySchema = z.object({
  id: z.string().regex(TICKET_ID),
  track: z.enum(TRACKS),
  order: z.number().int().min(1).max(99),
  branch: z.string().regex(TICKET_ID),
  tag: z.string().regex(/^(front|back)-[1-9][0-9]?-v\d+\.\d+\.\d+$/),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
  commitMessage: z.string().max(200),
  /** treeDigest of the ticket branch files. */
  codeDigest: digest,
  codeFiles: z.number().int().positive(),
  package: z.object({
    path: z.string(),
    files: z.number().int().positive(),
    /** treeDigest of tickets/<id>/ without PACKAGE_EXCLUDED. */
    digest,
  }),
});

export const manifestSchema = z
  .object({
    format: z.literal('bug-detective-project'),
    formatVersion: z.literal(1),
    project: z.object({
      id: z.string().regex(/^[a-z][a-z0-9-]{0,39}$/),
      name: z.string().min(1).max(100),
      /** Shown on the Projects screen (package.json bugDetective.project.difficulty). */
      difficulty: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
    }),
    version: z.string().regex(/^\d+\.\d+\.\d+$/),
    createdAt: z.string(),
    tickets: z.object({
      total: z.number().int().min(1),
      front: z.number().int().min(0),
      back: z.number().int().min(0),
    }),
    entries: z.array(ticketEntrySchema),
  })
  .superRefine((manifest, ctx) => {
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
    const { tickets, entries } = manifest;
    if (tickets.total !== tickets.front + tickets.back) {
      issue(`tickets.total (${tickets.total}) must be front + back (${tickets.front + tickets.back})`);
    }
    for (const track of TRACKS) {
      const count = entries.filter((entry) => entry.track === track).length;
      if (count !== tickets[track]) {
        issue(`tickets.${track} is ${tickets[track]}, but there are ${count} ${track} entries`);
      }
    }
    // The queue: every front ticket in order, then every back ticket in order.
    const expected = TRACKS.flatMap((track) => Array.from({ length: entries.filter((e) => e.track === track).length }, (_, i) => `${track}-${i + 1}`));
    entries.forEach((entry, index) => {
      if (entry.id !== `${entry.track}-${entry.order}` || entry.branch !== entry.id) {
        issue(`Entry ${index + 1}: id and branch must be ${entry.track}-${entry.order}`);
      } else if (entry.id !== expected[index]) {
        issue(`Entry ${index + 1} (${entry.id}): the entries must be in queue order (${expected.join(', ')})`);
      }
      if (entry.package.path !== `tickets/${entry.id}`) {
        issue(`Entry ${entry.id}: package path must be tickets/${entry.id}`);
      }
    });
  });

export type TicketEntry = z.infer<typeof ticketEntrySchema>;
export type ProjectManifest = z.infer<typeof manifestSchema>;

export class ContentVerificationError extends Error {}

/** Validates a manifest; with expectedProject, also that it belongs to that project. */
export function parseManifest(json: unknown, expectedProject?: string): ProjectManifest {
  const result = manifestSchema.safeParse(json);
  if (!result.success) {
    throw new ContentVerificationError(`Invalid project manifest: ${result.error.issues[0]?.message ?? 'unknown error'}`);
  }
  if (expectedProject !== undefined && result.data.project.id !== expectedProject) {
    throw new ContentVerificationError(`The manifest belongs to another project (${result.data.project.id}, expected ${expectedProject})`);
  }
  return result.data;
}

/** The ticket at a queue position (1..total). */
export function ticketAt(manifest: ProjectManifest, position: number): TicketEntry {
  const entry = Number.isInteger(position) && position >= 1 ? manifest.entries[position - 1] : undefined;
  if (!entry) {
    throw new ContentVerificationError(`Ticket ${position} is not in the manifest (${manifest.tickets.total} tickets)`);
  }
  return entry;
}

/** Compares two X.Y.Z versions: negative, zero or positive. */
export function compareVersions(a: string, b: string): number {
  const [x, y] = [a.split('.').map(Number), b.split('.').map(Number)];
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}

/** Files of the authoring folder that never go into a player's ticket package. */
export const PACKAGE_EXCLUDED = new Set(['bug.patch']);
