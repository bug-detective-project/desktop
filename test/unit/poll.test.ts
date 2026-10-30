import { describe, expect, it } from 'vitest';
import { skipWhileRunning } from '../../src/main/services/poll.ts';

describe('skipWhileRunning', () => {
  it('skips a call made while the previous one still runs, and runs again once it finished', async () => {
    let calls = 0;
    let release!: () => void;
    const poll = skipWhileRunning(async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    const first = poll();
    await poll();
    expect(calls).toBe(1);
    release();
    await first;
    const next = poll();
    expect(calls).toBe(2);
    release();
    await next;
  });

  it('runs again after a check that failed', async () => {
    let calls = 0;
    const poll = skipWhileRunning(async () => {
      calls += 1;
      throw new Error('docker did not answer');
    });
    await expect(poll()).rejects.toThrow('docker did not answer');
    await expect(poll()).rejects.toThrow('docker did not answer');
    expect(calls).toBe(2);
  });
});
