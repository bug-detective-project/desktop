/** The content source interface and the checksum verification shared by every source. */
import { verifyCode, verifyPackage } from '@bug-detective/catalog/contract';
import type { ArchiveFile, ProjectManifest, TicketEntry } from '@bug-detective/catalog/contract';
import type { TrackCounts } from '../../../shared/types.ts';

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
  /** Deletes the downloaded content (the project left the computer); a local folder has none. */
  forget?(): Promise<void>;
}

/** The published manifest names a commit that the repository does not have (yet). */
/** Verifies a fetched ticket against its manifest entry. Nothing is used before this passes. */
export function verifyTicket(ticket: FetchedTicket): FetchedTicket {
  verifyPackage(ticket.entry, ticket.packageFiles);
  verifyCode(ticket.entry, ticket.codeFiles);
  return ticket;
}
