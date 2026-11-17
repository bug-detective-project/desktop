import type { Language } from '@shared/types.ts';

/** "5.5 GB" in English, "5,5 GB" in Portuguese: memory as Docker's own settings count it (1 GB = 1024³ bytes). */
export function gigabytes(bytes: number, language: Language): string {
  const value = String(Number((bytes / 1024 ** 3).toFixed(1)));
  return `${language === 'pt' ? value.replace('.', ',') : value} GB`;
}
