import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewOf } from '../client/preview.js';

test('previews are cut at 40 characters', () => {
  assert.equal(previewOf({ text: 'y'.repeat(41) }).length, 40);
});
