import assert from 'node:assert/strict';
import { test } from 'node:test';
import { search } from '../server/api.js';

test('search matches the text in any case', () => {
  assert.equal(search([{ title: '', text: 'Call MOM' }], 'mom').length, 1);
});
