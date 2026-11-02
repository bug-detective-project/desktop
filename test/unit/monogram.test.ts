import { describe, expect, it } from 'vitest';
import { monogram } from '../../src/renderer/src/screens/monogram.ts';

describe('monogram', () => {
  it.each([
    ['SupportDesk', 'SD'],
    ['Inventory Tracker', 'IT'],
    ['Notes', 'NO'],
    ['ínventário geral', 'ÍG'],
    ['  Tasklist  app  ', 'TA'],
  ])('%s → %s', (name, expected) => {
    expect(monogram(name)).toBe(expected);
  });
});
