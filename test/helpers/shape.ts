/**
 * The shape of a JSON value: every field path with its type, arrays reduced to their first
 * element, values ignored. Two values of the same shape have the same fields with the same types,
 * which is what the stories need from their captured data (src/renderer/src/storybook/data/).
 */
export type Shape = Record<string, string>;

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export function shapeOf(value: unknown, path = '$', into: Shape = {}): Shape {
  const type = typeOf(value);
  into[path] = type;
  if (type === 'array') {
    const [first] = value as unknown[];
    if (first !== undefined) shapeOf(first, `${path}[]`, into);
  } else if (type === 'object') {
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      shapeOf((value as Record<string, unknown>)[key], `${path}.${key}`, into);
    }
  }
  return into;
}

/** The paths whose type differs, is missing or is new, as "path: stored → captured" lines. */
export function shapeDifferences(stored: Shape, captured: Shape): string[] {
  const lines: string[] = [];
  for (const path of [...new Set([...Object.keys(stored), ...Object.keys(captured)])].sort()) {
    const before = stored[path] ?? '(missing)';
    const after = captured[path] ?? '(missing)';
    if (before !== after) lines.push(`${path}: ${before} → ${after}`);
  }
  return lines;
}
