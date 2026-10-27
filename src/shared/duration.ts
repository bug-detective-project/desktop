/** The QA time limit is stored in seconds and shown in minutes ("3", "2.5"; "2,5" is accepted too). */

/** Seconds as minutes for the field: whole numbers when possible, at most two decimals. */
export function toMinutes(seconds: number): string {
  return String(Number((seconds / 60).toFixed(2)));
}

/** Parses the minutes the player typed into whole seconds, or null when it is not a number. */
export function parseMinutes(text: string): number | null {
  const value = text.trim().replace(',', '.');
  if (!/^\d+(\.\d+)?$/.test(value)) {
    return null;
  }
  return Math.round(Number(value) * 60);
}
