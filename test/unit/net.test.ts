import { describe, expect, it, vi } from 'vitest';
import { appFetch, fetchTextWith } from '../../src/main/net.ts';

describe('appFetch', () => {
  it('downloads through Electron net when it is there, with the same arguments', async () => {
    const net = { fetch: vi.fn(async () => new Response('ok')) };
    const fetchImpl = appFetch({ net });
    await fetchImpl('https://example.test/x', { method: 'GET' });
    expect(net.fetch).toHaveBeenCalledWith('https://example.test/x', { method: 'GET' });
  });

  it('falls back to the global fetch outside Electron', async () => {
    const original = globalThis.fetch;
    const spy = vi.fn(async () => new Response('plain'));
    globalThis.fetch = spy as unknown as typeof fetch;
    try {
      expect(await (await appFetch(null)('https://example.test/y')).text()).toBe('plain');
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('fetchTextWith', () => {
  it('returns the text of a 200 and fails on any other status', async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => (String(url).endsWith('/ok') ? new Response('hello') : new Response('', { status: 503 })));
    const fetchText = fetchTextWith(fetchImpl as unknown as typeof fetch);
    expect(await fetchText('https://example.test/ok')).toBe('hello');
    await expect(fetchText('https://example.test/down')).rejects.toThrow(/answered 503/);
    expect((fetchImpl.mock.calls[0] as unknown[])[1]).toMatchObject({ signal: expect.any(AbortSignal) });
  });
});
