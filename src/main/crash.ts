/**
 * Whether a renderer that just died should be reloaded on its own, or the player asked: the first
 * crash in a minute is reloaded quietly; a second one within that minute means something keeps
 * crashing, so a dialog offers Reload, Copy diagnostics and Quit instead of a loop.
 */
export const CRASH_WINDOW_MS = 60_000;

export function shouldReloadAfterCrash(history: readonly number[], now: number): boolean {
  return !history.some((at) => now - at < CRASH_WINDOW_MS);
}
