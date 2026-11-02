import assert from 'node:assert/strict';
import { test } from 'node:test';
import { search } from '../server/api.js';

test('search ignores case', () => {
  assert.equal(search([{ title: 'Groceries', text: '' }], 'groceries').length, 1);
});
