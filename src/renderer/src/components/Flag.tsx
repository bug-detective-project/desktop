import type { Language } from '@shared/types.ts';

/** A small flag for a language (the United States for English, Brazil for Portuguese). */
export function Flag({ language }: { language: Language }) {
  return language === 'en' ? (
    <svg className="h-3 w-4 shrink-0 rounded-xs shadow-2xs" viewBox="0 0 20 15" fill="none" aria-hidden>
      <rect width="20" height="15" fill="#B22234" rx="1" />
      <path d="M0 2.3h20M0 4.6h20M0 6.9h20M0 9.2h20M0 11.5h20M0 13.8h20" stroke="#fff" strokeWidth="1.15" />
      <rect width="8" height="7" fill="#3C3B6E" />
      <circle cx="4" cy="3.5" r="1.5" fill="#fff" />
    </svg>
  ) : (
    <svg className="h-3 w-4 shrink-0 rounded-xs shadow-2xs" viewBox="0 0 20 15" fill="none" aria-hidden>
      <rect width="20" height="15" fill="#009C3B" rx="1" />
      <polygon points="10,2 18,7.5 10,13 2,7.5" fill="#FFDF00" />
      <circle cx="10" cy="7.5" r="3" fill="#002776" />
      <path d="M7.5 7.5a3 3 0 0 1 5 0" stroke="#fff" strokeWidth="0.6" />
    </svg>
  );
}
