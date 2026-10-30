/** Periodic checks that must never pile up. */

/**
 * Wraps an async check so that a call made while the previous one still runs is skipped, not
 * stacked: a slow Docker never gets a second `docker version`, and an older answer never lands last.
 */
export function skipWhileRunning(check: () => Promise<unknown>): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await check();
    } finally {
      running = false;
    }
  };
}
