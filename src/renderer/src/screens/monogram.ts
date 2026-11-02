/**
 * The two letters on a project card: the initials of the first two words ("Inventory Tracker" →
 * "IT"), the two capitals of a single camel-case word ("SupportDesk" → "SD"), otherwise its first
 * two letters ("Notes" → "NO").
 */
export function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return (words[0][0] + words[1][0]).toLocaleUpperCase();
  }
  const word = words[0] ?? '';
  const capitals = [...word].filter((char) => char !== char.toLocaleLowerCase());
  return (capitals.length >= 2 ? capitals[0] + capitals[1] : word.slice(0, 2)).toLocaleUpperCase();
}
