import assert from 'node:assert/strict';
import { test } from 'node:test';
import { previewOf } from '../client/preview.js';

test('a long preview ends with an ellipsis', () => {
  assert.equal(previewOf({ text: 'x'.repeat(50) }), `${'x'.repeat(39)}…`);
});
