/**
 * Review configuration of a learning project (content/projects/<projectId>/review.json): the files
 * left out of the code comparison, the review branch and the automatic work-in-progress commit.
 * Built-in defaults always apply on top of a project's list. Nothing here is project-specific.
 */
import { z } from 'zod';

/** Applied to every project, even when its configuration or .gitignore forgets something. */
export const DEFAULT_EXCLUDES = [
  '**/node_modules/**',
  '**/package-lock.json',
  '**/npm-shrinkwrap.json',
  '**/yarn.lock',
  '**/pnpm-lock.yaml',
  '**/bun.lockb',
  '**/*.db',
  '**/*.db-*',
  '**/*.sqlite*',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
  '**/.env*',
  '**/*.log',
  '**/logs/**',
] as const;

/** Test files, left out only when a project sets "includeTests": false. */
export const TEST_GLOBS = ['**/*.test.*', '**/*.spec.*', '**/__tests__/**'] as const;

// Globs are relative POSIX paths made of plain path characters and *, ? (no leading slash, no "..").
const glob = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9_.*?@+\-/]+$/)
  .refine((value) => !value.startsWith('/') && !value.split('/').includes('..'), 'Globs must be relative paths');

export const reviewConfigSchema = z.object({
  exclude: z.array(glob).max(200).default([]),
  includeTests: z.boolean().default(true),
});

export interface ReviewConfig {
  /** Project globs plus the built-in defaults, without duplicates. */
  exclude: string[];
  includeTests: boolean;
}

/** Validates a project's review.json (or nothing, for a project without one) and adds the defaults. */
export function parseReviewConfig(raw: unknown = {}): ReviewConfig {
  const parsed = reviewConfigSchema.parse(raw);
  const exclude = [...DEFAULT_EXCLUDES, ...parsed.exclude, ...(parsed.includeTests ? [] : TEST_GLOBS)];
  return { exclude: [...new Set(exclude)], includeTests: parsed.includeTests };
}

/**
 * Git "glob" pathspec semantics: `*` and `?` never cross a slash; `**` followed by a slash matches
 * zero or more folders, and a trailing slash plus `**` matches everything inside a folder.
 */
export function globToRegExp(pattern: string): RegExp {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (pattern.startsWith('**/', index)) {
      source += '(?:.*/)?';
      index += 2;
    } else if (pattern.startsWith('/**', index) && index + 3 === pattern.length) {
      source += '/.*';
      index += 2;
    } else if (pattern.startsWith('**', index)) {
      source += '.*';
      index += 1;
    } else if (char === '*') {
      source += '[^/]*';
    } else if (char === '?') {
      source += '[^/]';
    } else {
      source += char.replace(/[.+^${}()|[\]\\-]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

export function excludeMatcher(config: ReviewConfig): (path: string) => boolean {
  const patterns = config.exclude.map(globToRegExp);
  return (path) => patterns.some((pattern) => pattern.test(path));
}

/** Explicit exclude pathspecs for git commands, so a project's .gitignore never decides. */
export function excludePathspecs(config: ReviewConfig): string[] {
  return config.exclude.map((pattern) => `:(exclude,glob)${pattern}`);
}

/** The same globs in .gitignore syntax, used as a temporary excludes file while a review is open. */
export function excludesFileContent(config: ReviewConfig): string {
  return `${config.exclude.join('\n')}\n`;
}

// Bundled with the app: every content/projects/<projectId>/review.json.
const PROJECT_CONFIGS = import.meta.glob<unknown>('../../../../content/projects/*/review.json', { eager: true, import: 'default' });

/** The review configuration of the project the app plays (package.json bugDetective.project). */
export function loadReviewConfig(projectId: string, configs: Record<string, unknown> = PROJECT_CONFIGS): ReviewConfig {
  const entry = Object.entries(configs).find(([path]) => path.endsWith(`/projects/${projectId}/review.json`));
  return parseReviewConfig(entry?.[1]);
}
