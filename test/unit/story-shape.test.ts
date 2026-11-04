import { describe, expect, it } from 'vitest';
import { shapeDifferences, shapeOf } from '../helpers/shape.ts';

describe('shapeOf', () => {
  it('lists every field path with its type, arrays by their first element, values ignored', () => {
    const shape = shapeOf({ a: 1, b: 'x', c: null, d: [{ e: true }, { e: false, extra: 1 }], f: [] });
    expect(shape).toEqual({
      $: 'object',
      '$.a': 'number',
      '$.b': 'string',
      '$.c': 'null',
      '$.d': 'array',
      '$.d[]': 'object',
      '$.d[].e': 'boolean',
      '$.f': 'array',
    });
    expect(shapeOf({ a: 2, b: 'other', c: null, d: [{ e: false }], f: [] })).toEqual(shape);
  });

  it('names the paths whose type changed, went missing or are new', () => {
    const stored = shapeOf({ id: 1, name: 'x', old: true, nested: { n: 1 } });
    const captured = shapeOf({ id: '1', name: 'y', nested: { n: 1, m: null } });
    expect(shapeDifferences(stored, captured)).toEqual(['$.id: number → string', '$.nested.m: (missing) → null', '$.old: boolean → (missing)']);
    expect(shapeDifferences(stored, stored)).toEqual([]);
  });
});
