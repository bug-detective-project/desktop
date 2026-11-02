import type { ProjectCard, ProjectDifficulty } from '@shared/api.ts';
import type { Language } from '@shared/types.ts';

export type LevelFilter = 'all' | ProjectDifficulty;

/** Lower case without accents, so "Inventário" matches "inventario". */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase();
}

/** What a project can be found by, in the active language: name, description, stack and skills. */
function searchableText(card: ProjectCard, language: Language): string {
  const { details } = card;
  if (!details) {
    return card.id;
  }
  return [details.name[language], details.about[language], details.stack?.frontend, details.stack?.backend, details.stack?.database, ...details.skills[language]]
    .filter(Boolean)
    .join('\n');
}

/** The projects that match the search (a substring, ignoring case and accents) and the difficulty. */
export function filterProjects(cards: readonly ProjectCard[], filters: { query: string; level: LevelFilter }, language: Language): ProjectCard[] {
  const query = fold(filters.query.trim());
  return cards.filter(
    (card) => (filters.level === 'all' || card.details?.difficulty === filters.level) && (query === '' || fold(searchableText(card, language)).includes(query)),
  );
}
