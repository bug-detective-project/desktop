/**
 * Every error code the main process sends to the renderer has a message in both languages
 * (locales errors.<code>), so a player never sees a code or an untranslated sentence.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..', '..');
const locale = (language: string) => JSON.parse(readFileSync(join(root, 'src', 'renderer', 'src', 'locales', `${language}.json`), 'utf8')) as { errors: Record<string, string> };

function mainSources(dir = join(root, 'src', 'main')): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? mainSources(join(dir, entry.name)) : entry.name.endsWith('.ts') ? [readFileSync(join(dir, entry.name), 'utf8')] : [],
  );
}

const codes = [...new Set(mainSources().flatMap((source) => [...source.matchAll(/new GameError\('([A-Za-z]+)'|error: \{ code: '([A-Za-z]+)'/g)].map((match) => match[1] ?? match[2])))].sort();

describe('error messages', () => {
  it('finds the codes the main process sends', () => {
    expect(codes).toEqual(expect.arrayContaining(['busy', 'failed', 'ticketNotDone', 'dockerUnavailable']));
  });

  it.each(['en', 'pt'])('every code has a message in %s', (language) => {
    const errors = locale(language).errors;
    expect(codes.filter((code) => !errors[code])).toEqual([]);
  });
});
