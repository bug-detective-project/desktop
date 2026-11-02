import assert from 'node:assert/strict';
import { test } from 'node:test';
import { titleOf } from '../client/notes.js';

test('a note without a title shows Untitled', () => {
  assert.equal(titleOf({ title: '  ' }), 'Untitled');
});
