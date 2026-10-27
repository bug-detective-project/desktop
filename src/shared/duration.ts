/** The QA time limit as the player types it: "3 min 00 s", "3m", "2:30", "90s" or plain seconds. */

/** Formats seconds as "3 min 00 s" (the same text in English and Portuguese). */
export function formatDuration(seconds: number): string {
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, '0')} s`;
}

/** Parses what the player typed into whole seconds, or null when it is not a duration. */
export function parseDuration(text: string): number | null {
  const value = text.trim().toLowerCase().replace(',', '.');
  if (/^\d+$/.test(value)) {
    return Number(value);
  }
  const clock = /^(\d+):([0-5]\d)$/.exec(value);
  if (clock) {
    return Number(clock[1]) * 60 + Number(clock[2]);
  }
  const parts = /^(?:(\d+(?:\.\d+)?)\s*(?:m|min|mins|minutes?|minutos?))?\s*(?:(\d+)\s*(?:s|sec|secs|seconds?|seg|segundos?))?$/.exec(value);
  if (!parts || (parts[1] === undefined && parts[2] === undefined)) {
    return null;
  }
  const seconds = Number(parts[1] ?? 0) * 60 + Number(parts[2] ?? 0);
  return Number.isInteger(seconds) ? seconds : null;
}
