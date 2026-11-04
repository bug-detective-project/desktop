/**
 * The fetch the app downloads with. In Electron it is net.fetch, which goes through Chromium's
 * network stack: the system proxy (and its authentication) and the system certificates apply, as
 * in the browser. Outside Electron (the unit tests, scripts) it is Node's fetch.
 */
export type Fetch = typeof fetch;

/** Electron's net: its fetch takes a few options of its own on top of the standard ones. */
interface NetLike {
  fetch(input: string | Request | URL, init?: RequestInit): Promise<Response>;
}

export function appFetch(electron: { net?: NetLike } | null | undefined): Fetch {
  const net = electron?.net;
  return net ? (input, init) => net.fetch(input, init) : (input, init) => fetch(input, init);
}

const TIMEOUT_MS = 30_000;

/** A text download with a time limit, for the catalog service. */
export function fetchTextWith(fetchImpl: Fetch, timeoutMs = TIMEOUT_MS): (url: string) => Promise<string> {
  return async (url) => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) {
      throw new Error(`${url} answered ${response.status}`);
    }
    return response.text();
  };
}
