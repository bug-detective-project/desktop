import { describe, expect, it } from 'vitest';

// api.ts reads window.bugDetective when it loads; errorInfo itself needs nothing from it.
(globalThis as { window?: unknown }).window = { bugDetective: {} };
const { errorInfo } = await import('../../src/renderer/src/api.ts');

describe('errorInfo', () => {
  it('splits "[code] message" from the preload bridge', () => {
    expect(errorInfo(new Error('[ticketNotDone] Finish the open ticket first'))).toEqual({ code: 'ticketNotDone', message: 'Finish the open ticket first' });
  });

  it('keeps a multi-line message whole', () => {
    expect(errorInfo(new Error('[failed] docker build failed\nstep 3'))).toEqual({ code: 'failed', message: 'docker build failed\nstep 3' });
  });

  it('reads an error the bridge wrapped in its own text', () => {
    expect(errorInfo(new Error("Error invoking remote method 'bd:move': [busy] Busy: qa"))).toEqual({ code: 'busy', message: 'Busy: qa' });
  });

  it('calls anything else "failed", with its text as the message', () => {
    expect(errorInfo(new Error('Write permission denied.'))).toEqual({ code: 'failed', message: 'Write permission denied.' });
    expect(errorInfo('plain text')).toEqual({ code: 'failed', message: 'plain text' });
  });
});
