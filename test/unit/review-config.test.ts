import { describe, expect, it } from 'vitest';
import {
  DEFAULT_EXCLUDES,
  excludeMatcher,
  excludePathspecs,
  globToRegExp,
  parseReviewConfig,
} from '../../src/main/services/review/config.ts';

describe('review configuration', () => {
  it('always applies the built-in defaults, even without a project file', () => {
    const config = parseReviewConfig();
    expect(config.exclude).toEqual([...DEFAULT_EXCLUDES]);
    expect(config.includeTests).toBe(true);
  });

  it('adds the project globs to the defaults without duplicates', () => {
    const config = parseReviewConfig({ exclude: ['**/tmp/**', '**/node_modules/**'] });
    expect(config.exclude).toEqual([...DEFAULT_EXCLUDES, '**/tmp/**']);
  });

  it('leaves test files out only when the project asks for it', () => {
    expect(excludeMatcher(parseReviewConfig())('client/src/App.test.tsx')).toBe(false);
    expect(excludeMatcher(parseReviewConfig({ includeTests: false }))('client/src/App.test.tsx')).toBe(true);
  });

  it('rejects absolute paths, parent folders and shell characters', () => {
    for (const exclude of ['/etc/**', '../secrets/**', 'a;rm -rf', '$(id)', 'a b']) {
      expect(() => parseReviewConfig({ exclude: [exclude] })).toThrow();
    }
  });

  it('turns every glob into an explicit git exclude pathspec', () => {
    expect(excludePathspecs(parseReviewConfig({ exclude: ['**/out/**'] })).at(-1)).toBe(':(exclude,glob)**/out/**');
  });
});

describe('path matching', () => {
  const excluded = excludeMatcher(parseReviewConfig());

  it.each([
    'node_modules/react/index.js',
    'client/node_modules/vite/package.json',
    'package-lock.json',
    'client/package-lock.json',
    'server/data/supportdesk.db',
    'server/data/supportdesk.db-journal',
    'data/app.sqlite3',
    'dist/index.js',
    'client/build/assets/a.js',
    'coverage/lcov.info',
    '.env',
    'server/.env.local',
    'npm-debug.log',
    'logs/today.txt',
  ])('excludes %s', (path) => {
    expect(excluded(path)).toBe(true);
  });

  it.each([
    'client/src/App.tsx',
    'client/src/pages/TicketDetails.assignment.test.tsx',
    'server/src/routes/tickets.ts',
    'package.json',
    'README.md',
    'client/src/distance.ts',
    'src/environment.ts',
    'docs/build-notes.md',
  ])('keeps %s', (path) => {
    expect(excluded(path)).toBe(false);
  });

  it('follows git glob rules for * and ?', () => {
    expect(globToRegExp('src/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/*.ts').test('src/deep/a.ts')).toBe(false);
    expect(globToRegExp('src/**/*.ts').test('src/a.ts')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/deep/er/a.ts')).toBe(true);
    expect(globToRegExp('file?.txt').test('file1.txt')).toBe(true);
    expect(globToRegExp('file?.txt').test('file/.txt')).toBe(false);
  });
});
