/**
 * The project files of a qa branch besides its tickets: the QA tool (the CLI the QA image runs),
 * the review configuration (review.json) and the project's story (story.<lang>.json: the client,
 * the project and the manager's messages). Shared by publish:project and the content sources.
 */
import { z } from 'zod';
import { LANGUAGES } from '../../../shared/types.ts';
import type { Language } from '../../../shared/types.ts';
import { parseReviewConfig } from '../review/config.ts';
import type { ReviewConfig } from '../review/config.ts';
import { fileText } from './archive.ts';
import type { ArchiveFile } from './archive.ts';
import { TICKET_ID } from './manifest.ts';

const text = z.string().min(1);
const message = z.object({ subject: text, body: text });

export const projectStorySchema = z.object({
  client: z.object({ name: text, about: text, contacts: text, reporters: z.array(z.object({ name: text, role: text })) }),
  project: z.object({ name: text, about: text, stack: text }),
  messages: z.object({
    welcome: message,
    /** One message per ticket id (front-1, back-1, …); a ticket without one gets the generic text. */
    assignments: z.record(z.string().regex(TICKET_ID, 'assignments are keyed by ticket id, such as front-1'), message),
    /** The project is done: the first track the player completes. */
    completion: message,
    /** Every later track; {{track}} becomes front, back or fullstack. */
    trackCompletion: message,
  }),
});

export type ProjectStory = z.infer<typeof projectStorySchema>;

export const STORY_FILES = LANGUAGES.map((language) => `story.${language}.json`);

export function parseProjectStory(raw: unknown, file: string): ProjectStory {
  const result = projectStorySchema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new Error(`Invalid ${file}: ${issue?.path.join('.') || 'file'}: ${issue?.message ?? 'unknown error'}`);
  }
  return result.data;
}

/** The files of the qa branch that are not the QA tool. */
function notTool(path: string): boolean {
  return path.startsWith('tickets/') || path === 'manifest.json' || path === 'review.json' || STORY_FILES.includes(path);
}

/** The QA tool: the qa branch without the tickets, the manifest, the review configuration and the story. */
export function qaToolFiles(qaFiles: readonly ArchiveFile[]): ArchiveFile[] {
  return qaFiles.filter((file) => !notTool(file.path));
}

export interface ProjectFiles {
  review: ReviewConfig;
  story: Record<Language, ProjectStory>;
}

function json(file: ArchiveFile): unknown {
  try {
    return JSON.parse(fileText(file));
  } catch {
    throw new Error(`${file.path} is not valid JSON`);
  }
}

/** The review configuration and the story of a project, from the files of its qa branch. */
export function projectContentOf(qaFiles: readonly ArchiveFile[]): ProjectFiles {
  const byPath = new Map(qaFiles.map((file) => [file.path, file]));
  const reviewFile = byPath.get('review.json');
  const story = Object.fromEntries(
    LANGUAGES.map((language) => {
      const name = `story.${language}.json`;
      const file = byPath.get(name);
      if (!file) {
        throw new Error(`The qa branch has no ${name}`);
      }
      return [language, parseProjectStory(json(file), name)];
    }),
  ) as Record<Language, ProjectStory>;
  return { review: reviewOf(reviewFile ? json(reviewFile) : undefined), story };
}

function reviewOf(raw: unknown): ReviewConfig {
  try {
    return parseReviewConfig(raw);
  } catch (error) {
    const issue = error instanceof z.ZodError ? error.issues[0] : undefined;
    throw new Error(`Invalid review.json: ${issue ? `${issue.path.join('.')}: ${issue.message}` : (error as Error).message}`, { cause: error });
  }
}
