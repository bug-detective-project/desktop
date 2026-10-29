import ReactCountryFlag from 'react-country-flag';
import type { Language } from '@shared/types.ts';

/** The country of each language's flag: the United States for English, Brazil for Portuguese. */
const COUNTRY: Record<Language, string> = { en: 'US', pt: 'BR' };

/**
 * A small flag for a language, drawn by react-country-flag as an SVG. The SVGs (from flag-icons)
 * ship with the app in `public/flags/`: the content security policy allows only local images, and
 * the game works offline.
 */
export function Flag({ language }: { language: Language }) {
  return (
    <ReactCountryFlag
      svg
      countryCode={COUNTRY[language]}
      cdnUrl="./flags/"
      className="h-3 w-4 shrink-0 rounded-xs object-cover shadow-2xs"
      style={{ width: undefined, height: undefined }}
      aria-hidden
      alt=""
    />
  );
}
