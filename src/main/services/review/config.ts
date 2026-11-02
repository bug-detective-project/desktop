/**
 * Path matching for a project's review configuration (review.json, parsed by the catalog's content
 * contract): the files left out of the code comparison, the review branch and the automatic
 * work-in-progress commit. Nothing here is project-specific.
 */
import type { ReviewConfig } from '@bug-detective/catalog/contract';

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

