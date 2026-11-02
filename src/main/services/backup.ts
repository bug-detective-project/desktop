/**
 * Export and restore of progress as a single .bdsave zip:
 *   manifest.json        format, app version, schema version and SHA-256 of every other entry
 *   state.json           the game state
 *   workspace.bundle     `git bundle` of the workspace repository (player/* branches, stage tags)
 *   packages/stage-N.zip the downloaded ticket packages of the active project
 *   reviews/ticket-N/…   the PRs of the active project (review.json and snapshot.diff, no tree copies)
 *   projects/<id>/packages/stage-N.zip, projects/<id>/reviews/ticket-N/…
 *                        the same for every other project of the game (no repository: only the
 *                        active project's code is in Docker)
 */
import { z } from 'zod';
import { SCHEMA_VERSION } from '../../shared/types.ts';
import type { GameState } from '../../shared/types.ts';
import { UnsafeArchiveError, readZip, sha256Hex, writeZip } from '@bug-detective/catalog/contract';
import type { ArchiveFile } from '@bug-detective/catalog/contract';
import { parseState } from './state.ts';

export const SAVE_EXTENSION = 'bdsave';
export const MAX_SAVE_BYTES = 512 * 1024 * 1024;

export const saveManifestSchema = z.object({
  format: z.literal('bug-detective-save'),
  formatVersion: z.number().int(),
  appVersion: z.string().max(50),
  schemaVersion: z.number().int().min(1),
  createdAt: z.string(),
  files: z.record(
    z
      .string()
      .regex(
        /^(state\.json|workspace\.bundle|(projects\/[a-z][a-z0-9-]{0,39}\/)?(packages\/stage-\d{1,2}\.zip|reviews\/ticket-\d{1,2}\/(snapshot\.diff|review\.json)))$/,
      ),
    z.string().regex(/^[0-9a-f]{64}$/),
  ),
});

export type SaveManifest = z.infer<typeof saveManifestSchema>;

export class InvalidSaveError extends Error {}

/** The packages and PRs of one project (reviews keyed reviews/ticket-N/<file>). */
export interface ProjectFiles {
  packages: Map<number, Uint8Array>;
  reviews: Map<string, Uint8Array>;
}

export const SAVE_FORMAT_VERSION = 2;

export interface SaveContents {
  state: GameState;
  bundle: Uint8Array | null;
  packages: Map<number, Uint8Array>;
  /** Review data keyed reviews/ticket-N/<file>. */
  reviews?: Map<string, Uint8Array>;
  /** The packages and PRs of every other project of the game, by id. */
  others?: Map<string, ProjectFiles>;
}

/** Builds a save; one larger than readSave accepts would export fine and never restore, so it throws. */
export function createSave(contents: SaveContents, appVersion: string, now: string, maxBytes = MAX_SAVE_BYTES): Uint8Array {
  const files: ArchiveFile[] = [
    { path: 'state.json', data: Buffer.from(`${JSON.stringify(contents.state, null, 2)}\n`), executable: false },
  ];
  if (contents.bundle) {
    files.push({ path: 'workspace.bundle', data: contents.bundle, executable: false });
  }
  for (const [stage, zip] of [...contents.packages].sort(([a], [b]) => a - b)) {
    files.push({ path: `packages/stage-${stage}.zip`, data: zip, executable: false });
  }
  for (const [path, data] of [...(contents.reviews ?? [])].sort(([a], [b]) => (a < b ? -1 : 1))) {
    files.push({ path, data, executable: false });
  }
  for (const [project, other] of [...(contents.others ?? [])].sort(([a], [b]) => (a < b ? -1 : 1))) {
    for (const [stage, zip] of [...other.packages].sort(([a], [b]) => a - b)) {
      files.push({ path: `projects/${project}/packages/stage-${stage}.zip`, data: zip, executable: false });
    }
    for (const [path, data] of [...other.reviews].sort(([a], [b]) => (a < b ? -1 : 1))) {
      files.push({ path: `projects/${project}/${path}`, data, executable: false });
    }
  }
  const manifest: SaveManifest = {
    format: 'bug-detective-save',
    formatVersion: SAVE_FORMAT_VERSION,
    appVersion,
    schemaVersion: SCHEMA_VERSION,
    createdAt: now,
    files: Object.fromEntries(files.map((file) => [file.path, sha256Hex(file.data)])),
  };
  const save = writeZip([...files, { path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest, null, 2)), executable: false }]);
  if (save.length > maxBytes) {
    throw new Error(`The save would be larger than ${maxBytes} bytes, the most a save can restore`);
  }
  return save;
}

export interface ValidatedSave extends SaveContents {
  manifest: SaveManifest;
  reviews: Map<string, Uint8Array>;
  others: Map<string, ProjectFiles>;
}

/** Validates a .bdsave completely (manifest, checksums, state schema) before anything is restored. */
export function readSave(bytes: Uint8Array): ValidatedSave {
  if (bytes.length > MAX_SAVE_BYTES) {
    throw new InvalidSaveError('The file is too large to be a Bug Detective save');
  }
  let files: ArchiveFile[];
  try {
    files = readZip(bytes);
  } catch (error) {
    if (error instanceof UnsafeArchiveError) {
      throw new InvalidSaveError(`The file is not a valid Bug Detective save: ${error.message}`);
    }
    throw new InvalidSaveError('The file is not a Bug Detective save (not a valid zip)');
  }
  const byPath = new Map(files.map((file) => [file.path, file]));
  const manifestFile = byPath.get('manifest.json');
  if (!manifestFile) {
    throw new InvalidSaveError('The save has no manifest');
  }
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(Buffer.from(manifestFile.data).toString('utf8'));
  } catch {
    throw new InvalidSaveError('The save manifest is not valid JSON');
  }
  const parsed = saveManifestSchema.safeParse(manifestJson);
  if (!parsed.success) {
    throw new InvalidSaveError(`The save manifest is invalid: ${parsed.error.issues[0]?.message}`);
  }
  const manifest = parsed.data;
  if (manifest.formatVersion !== SAVE_FORMAT_VERSION) {
    throw new InvalidSaveError(
      manifest.formatVersion < SAVE_FORMAT_VERSION
        ? 'This save was made by an older, unsupported version of Bug Detective'
        : 'This save was created by a newer version of Bug Detective',
    );
  }
  if (manifest.schemaVersion > SCHEMA_VERSION) {
    throw new InvalidSaveError('This save was created by a newer version of Bug Detective');
  }
  if (manifest.schemaVersion < SCHEMA_VERSION) {
    throw new InvalidSaveError('This save was made by an older, unsupported version of Bug Detective');
  }
  if (!manifest.files['state.json']) {
    throw new InvalidSaveError('The save has no game state');
  }
  for (const [path, checksum] of Object.entries(manifest.files)) {
    const file = byPath.get(path);
    if (!file || sha256Hex(file.data) !== checksum) {
      throw new InvalidSaveError(`The save is damaged: ${path} does not match its checksum`);
    }
  }
  for (const path of byPath.keys()) {
    if (path !== 'manifest.json' && !manifest.files[path]) {
      throw new InvalidSaveError(`The save contains an unexpected file: ${path}`);
    }
  }

  let state: GameState;
  try {
    state = parseState(JSON.parse(Buffer.from(byPath.get('state.json')!.data).toString('utf8')));
  } catch (error) {
    throw new InvalidSaveError(`The saved game state is invalid: ${(error as Error).message.slice(0, 300)}`);
  }
  if (state.tickets.length > 0 && !manifest.files['workspace.bundle']) {
    throw new InvalidSaveError('The save has progress but no workspace repository');
  }

  const packages = new Map<number, Uint8Array>();
  for (const path of Object.keys(manifest.files)) {
    const match = /^packages\/stage-(\d+)\.zip$/.exec(path);
    if (match) {
      packages.set(Number(match[1]), byPath.get(path)!.data);
    }
  }
  for (const ticket of state.tickets) {
    if (!packages.has(ticket.ticket)) {
      throw new InvalidSaveError(`The save is missing the package for ticket ${ticket.ticket}`);
    }
  }
  const reviews = new Map<string, Uint8Array>();
  for (const path of Object.keys(manifest.files).filter((name) => name.startsWith('reviews/'))) {
    reviews.set(path, byPath.get(path)!.data);
  }
  const others = new Map<string, ProjectFiles>();
  for (const path of Object.keys(manifest.files)) {
    const match = /^projects\/([^/]+)\/(.+)$/.exec(path);
    if (!match) continue;
    const other = others.get(match[1]) ?? { packages: new Map(), reviews: new Map() };
    const stage = /^packages\/stage-(\d+)\.zip$/.exec(match[2]);
    if (stage) other.packages.set(Number(stage[1]), byPath.get(path)!.data);
    else other.reviews.set(match[2], byPath.get(path)!.data);
    others.set(match[1], other);
  }
  for (const [project, progress] of Object.entries(state.otherProjects)) {
    for (const ticket of progress.tickets) {
      if (!others.get(project)?.packages.has(ticket.ticket)) {
        throw new InvalidSaveError(`The save is missing the package of ${project}, ticket ${ticket.ticket}`);
      }
    }
  }
  return { manifest, state, bundle: byPath.get('workspace.bundle')?.data ?? null, packages, reviews, others };
}
