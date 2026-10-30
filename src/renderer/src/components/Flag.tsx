import type { Language } from '@shared/types.ts';
import br from '../assets/flags/br.svg';
import us from '../assets/flags/us.svg';

/** Each language's flag: the United States for English, Brazil for Portuguese. */
const FLAGS: Record<Language, string> = { en: us, pt: br };

/**
 * A small flag for a language. The SVGs (from flag-icons) are imported, so Vite bundles them with
 * the app (a missing file fails the build): the content security policy allows only local images,
 * and the game works offline.
 */
export function Flag({ language }: { language: Language }) {
  return <img src={FLAGS[language]} alt="" aria-hidden data-testid={`flag-${language}`} className="h-3 w-4 shrink-0 rounded-xs object-cover shadow-2xs" />;
}
