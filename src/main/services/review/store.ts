/**
 * Review data of every ticket that passed QA, kept in the app data folder so the in-app comparison
 * works without Docker and the review branch can be rebuilt after a restore:
 *   reviews/ticket-N/snapshot.zip   the approved snapshot (the files QA tested, after the excludes)
 *   reviews/ticket-N/reference.zip  the reference (stage commit + reference patch)
 *   reviews/ticket-N/review.json    commits, creation date and language, and the comparison diffs
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { ReviewComparison } from '../../../shared/api.ts';
import { LANGUAGES } from '../../../shared/types.ts';
import { readZip, writeZip } from '../content/archive.ts';
import type { ArchiveFile } from '../content/archive.ts';
import { renameWithRetry } from '../content/store.ts';

const commit = z.string().regex(/^[0-9a-f]{40,64}$/);

export const reviewMetaSchema = z.object({
  ticket: z.number().int().min(1),
  approvedAt: z.string(),
  /** Language of the review commit messages (the app setting when QA passed). */
  language: z.enum(LANGUAGES),
  commits: z.object({ approved: commit, reference: commit, snapshot: commit }),
  comparison: z.object({
    solutions: z.string(),
    solutionsIgnoringWhitespace: z.string(),
    baseline: z.string(),
    baselineIgnoringWhitespace: z.string(),
  }),
});

export type ReviewMeta = z.infer<typeof reviewMetaSchema>;

export interface StoredReview {
  meta: ReviewMeta;
  snapshot: ArchiveFile[];
  reference: ArchiveFile[];
}

/** The files of one ticket's review data, as stored and as carried in a save (reviews/ticket-N/<name>). */
export const REVIEW_FILES = ['snapshot.zip', 'reference.zip', 'review.json'] as const;

export class ReviewStore {
  readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  dir(ticket: number): string {
    return join(this.root, `ticket-${ticket}`);
  }

  has(ticket: number): boolean {
    return existsSync(join(this.dir(ticket), '.complete'));
  }

  /**
   * Stores a ticket's review data, replaced atomically. The approved snapshot is immutable: once a
   * ticket has review data, only identical data (a rebuild after a restore) is accepted, unless
   * `replace` is set (QA passing again for a ticket whose earlier pass could not be recorded).
   */
  async save(review: StoredReview, options: { replace?: boolean } = {}): Promise<void> {
    const { ticket } = review.meta;
    const files = {
      'snapshot.zip': writeZip(review.snapshot),
      'reference.zip': writeZip(review.reference),
      'review.json': Buffer.from(`${JSON.stringify(reviewMetaSchema.parse(review.meta), null, 2)}\n`),
    };
    if (this.has(ticket) && !options.replace) {
      const current = await readFile(join(this.dir(ticket), 'snapshot.zip'));
      if (!current.equals(Buffer.from(files['snapshot.zip']))) {
        throw new Error(`The approved snapshot of ticket ${ticket} already exists and cannot change`);
      }
    }
    await this.write(ticket, files);
  }

  /** Replaces all review data with the files of a save (keyed reviews/ticket-N/<file>). */
  async importSave(files: Map<string, Uint8Array>): Promise<void> {
    await this.clear();
    const tickets = new Map<number, Record<string, Uint8Array>>();
    for (const [path, data] of files) {
      const match = /^reviews\/ticket-(\d+)\/([a-z.]+)$/.exec(path);
      if (match) {
        tickets.set(Number(match[1]), { ...tickets.get(Number(match[1])), [match[2]]: data });
      }
    }
    for (const [ticket, entries] of tickets) {
      if (REVIEW_FILES.every((name) => entries[name])) {
        await this.import(ticket, entries as Record<(typeof REVIEW_FILES)[number], Uint8Array>);
      }
    }
  }

  /** Writes raw files (from a save), validating the metadata first. */
  async import(ticket: number, files: Record<(typeof REVIEW_FILES)[number], Uint8Array>): Promise<void> {
    const meta = reviewMetaSchema.parse(JSON.parse(Buffer.from(files['review.json']).toString('utf8')));
    if (meta.ticket !== ticket) {
      throw new Error(`Review data for ticket ${meta.ticket} found under ticket ${ticket}`);
    }
    readZip(files['snapshot.zip']);
    readZip(files['reference.zip']);
    await this.write(ticket, files);
  }

  private async write(ticket: number, files: Record<string, Uint8Array>): Promise<void> {
    const staging = join(this.root, `.staging-${ticket}-${randomUUID()}`);
    try {
      await mkdir(staging, { recursive: true });
      for (const [name, data] of Object.entries(files)) {
        await writeFile(join(staging, name), data);
      }
      await writeFile(join(staging, '.complete'), '');
      await rm(this.dir(ticket), { recursive: true, force: true });
      await renameWithRetry(staging, this.dir(ticket));
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }

  async meta(ticket: number): Promise<ReviewMeta | null> {
    if (!this.has(ticket)) {
      return null;
    }
    return reviewMetaSchema.parse(JSON.parse(await readFile(join(this.dir(ticket), 'review.json'), 'utf8')));
  }

  async load(ticket: number): Promise<StoredReview | null> {
    const meta = await this.meta(ticket);
    if (!meta) {
      return null;
    }
    const zip = async (name: string) => readZip(await readFile(join(this.dir(ticket), name)));
    return { meta, snapshot: await zip('snapshot.zip'), reference: await zip('reference.zip') };
  }

  async comparison(ticket: number): Promise<ReviewComparison | null> {
    return (await this.meta(ticket))?.comparison ?? null;
  }

  /** Every stored file, keyed reviews/ticket-N/<name>, for a save. */
  async exportFiles(): Promise<Map<string, Uint8Array>> {
    const files = new Map<string, Uint8Array>();
    const entries = existsSync(this.root) ? await readdir(this.root) : [];
    for (const entry of entries.filter((name) => /^ticket-\d+$/.test(name)).sort()) {
      if (!existsSync(join(this.root, entry, '.complete'))) {
        continue;
      }
      for (const name of REVIEW_FILES) {
        files.set(`reviews/${entry}/${name}`, await readFile(join(this.root, entry, name)));
      }
    }
    return files;
  }

  async clear(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }
}
