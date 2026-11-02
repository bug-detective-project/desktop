import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sortNotes } from '../client/sort.js';

test('notes are listed newest first', () => {
  const notes = [{ updatedAt: '2026-01-01' }, { updatedAt: '2026-03-01' }];
  assert.deepEqual(sortNotes(notes).map((note) => note.updatedAt), ['2026-03-01', '2026-01-01']);
});
