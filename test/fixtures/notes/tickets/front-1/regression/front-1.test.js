import assert from 'node:assert/strict';
import { test } from 'node:test';
import { titleOf } from '../client/notes.js';

test('an empty title shows Untitled', () => {
  assert.equal(titleOf({}), 'Untitled');
});
