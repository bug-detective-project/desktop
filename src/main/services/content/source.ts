/** The content source interface and the checksum verification shared by every source. */
import type { ArchiveFile } from './archive.ts';
import { treeDigest } from './archive.ts';
import type { TrackCounts } from '../../../shared/types.ts';
import { ContentVerificationError, PACKAGE_EXCLUDED } from './manifest.ts';
import type { ProjectManifest, TicketEntry } from './manifest.ts';

export interface FetchedTicket {
  /** The project's tickets per track in the manifest the ticket came from. */
  counts: TrackCounts;
  manifestVersion: string;
  entry: TicketEntry;
  /** The player's package: tickets/<id>/ without PACKAGE_EXCLUDED, paths relative to that folder. */
  packageFiles: ArchiveFile[];
  /** The files of the ticket branch at entry.commit. */
  codeFiles: ArchiveFile[];
}

/** A project's published content: its manifest and every file of its qa branch, verified. */
export interface ProjectContent {
  manifest: ProjectManifest;
  qaFiles: ArchiveFile[];
}

export interface ContentSource {
  readonly kind: 'local' | 'github';
  /** Human-readable origin, for Settings and logs. */
  describe(): string;
  /** Gets the project's content, downloading it when the source is remote (the setup step). */
  prepare(signal?: AbortSignal): Promise<ProjectContent>;
  /** The content available without the network (a cache or a local folder), or null. */
  current(): Promise<ProjectContent | null>;
  /** Fetches and verifies a ticket by id (front-1, …). Throws ContentVerificationError on any mismatch. */
  fetchTicket(id: string, signal?: AbortSignal): Promise<FetchedTicket>;
}

/** The published manifest names a commit that the repository does not have (yet). */
export class IncompletePublicationError extends ContentVerificationError {}

/** The published manifest has no ticket with that id (a newer publication with fewer tickets). */
export class TicketNotPublishedError extends ContentVerificationError {
  readonly counts: TrackCounts;

  constructor(id: string, counts: TrackCounts) {
    super(`Ticket ${id} is not in the manifest`);
    this.counts = counts;
  }
}

/** The project's tickets per track. */
export function countsOf(manifest: ProjectManifest): TrackCounts {
  return { front: manifest.tickets.front, back: manifest.tickets.back };
}

/** The manifest entry of a ticket id, or TicketNotPublishedError. */
export function entryById(manifest: ProjectManifest, id: string): TicketEntry {
  const entry = manifest.entries.find((item) => item.id === id);
  if (!entry) {
    throw new TicketNotPublishedError(id, countsOf(manifest));
  }
  return entry;
}

/** The package files of a ticket out of the files of the whole qa branch. */
export function packageOf(entry: TicketEntry, qaFiles: readonly ArchiveFile[]): ArchiveFile[] {
  const prefix = `${entry.package.path}/`;
  return qaFiles
    .filter((file) => file.path.startsWith(prefix) && !PACKAGE_EXCLUDED.has(file.path.slice(prefix.length)))
    .map((file) => ({ ...file, path: file.path.slice(prefix.length) }));
}

/** Checks a ticket package against its manifest entry. */
export function verifyPackage(entry: TicketEntry, packageFiles: ArchiveFile[]): ArchiveFile[] {
  if (packageFiles.length !== entry.package.files || treeDigest(packageFiles) !== entry.package.digest) {
    throw new ContentVerificationError(`Ticket ${entry.id}: the package does not match the manifest`);
  }
  return packageFiles;
}

/** Checks a ticket's code against its manifest entry. */
export function verifyCode(entry: TicketEntry, codeFiles: ArchiveFile[]): ArchiveFile[] {
  if (codeFiles.length !== entry.codeFiles || treeDigest(codeFiles) !== entry.codeDigest) {
    throw new ContentVerificationError(`Ticket ${entry.id}: the ticket code does not match the manifest`);
  }
  return codeFiles;
}

/** Verifies a fetched ticket against its manifest entry. Nothing is used before this passes. */
export function verifyTicket(ticket: FetchedTicket): FetchedTicket {
  verifyPackage(ticket.entry, ticket.packageFiles);
  verifyCode(ticket.entry, ticket.codeFiles);
  return ticket;
}
