import { describe, expect, it } from 'vitest';
import { shouldReloadAfterCrash } from '../../src/main/crash.ts';

describe('shouldReloadAfterCrash', () => {
  it('reloads the first crash quietly, and the next one only after a minute', () => {
    expect(shouldReloadAfterCrash([], 1_000_000)).toBe(true);
    expect(shouldReloadAfterCrash([1_000_000], 1_030_000)).toBe(false);
    expect(shouldReloadAfterCrash([1_000_000], 1_060_000)).toBe(true);
    expect(shouldReloadAfterCrash([1_000_000, 1_030_000], 1_070_000)).toBe(false);
  });
});
