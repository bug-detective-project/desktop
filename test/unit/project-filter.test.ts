import { describe, expect, it } from 'vitest';
import type { ProjectCard } from '../../src/shared/api.ts';
import { filterProjects } from '../../src/renderer/src/screens/projectFilter.ts';

const both = (text: string) => ({ en: text, pt: text });

function card(id: string, details: Partial<NonNullable<ProjectCard['details']>> | null): ProjectCard {
  return {
    id,
    active: false,
    played: false,
    details: details && {
      name: both(id),
      about: both(''),
      client: both('Client'),
      stack: null,
      skills: { en: [], pt: [] },
      difficulty: null,
      counts: { front: 1, back: 0 },
      ...details,
    },
    progress: null,
    unavailable: null,
  };
}

const cards = [
  card('SupportDesk', { about: both('A support app'), difficulty: 'beginner', stack: { frontend: 'React · Vite', database: 'SQLite' }, skills: { en: ['Async and state'], pt: ['Assincronia e estado'] } }),
  card('Inventário', { about: { en: 'Stock control', pt: 'Controle de estoque' }, difficulty: 'intermediate', stack: { backend: 'Python · FastAPI' } }),
  card('Payments', { difficulty: 'advanced' }),
  card('gone', null),
];
const ids = (list: ProjectCard[]) => list.map((item) => item.id);

describe('filterProjects', () => {
  it('shows every project without a query or a level', () => {
    expect(ids(filterProjects(cards, { query: '', level: 'all' }, 'en'))).toEqual(['SupportDesk', 'Inventário', 'Payments', 'gone']);
  });

  it.each([
    ['the name', 'support', ['SupportDesk']],
    ['the description', 'stock', ['Inventário']],
    ['the stack', 'fastapi', ['Inventário']],
    ['the database', 'sqlite', ['SupportDesk']],
    ['a skill', 'async', ['SupportDesk']],
  ])('matches %s', (_field, query, expected) => {
    expect(ids(filterProjects(cards, { query, level: 'all' }, 'en'))).toEqual(expected);
  });

  it('ignores case, accents and the spaces around the query', () => {
    expect(ids(filterProjects(cards, { query: '  INVENTARIO ', level: 'all' }, 'en'))).toEqual(['Inventário']);
    expect(ids(filterProjects(cards, { query: 'inventário', level: 'all' }, 'en'))).toEqual(['Inventário']);
  });

  it('searches the texts of the active language', () => {
    expect(ids(filterProjects(cards, { query: 'estoque', level: 'all' }, 'pt'))).toEqual(['Inventário']);
    expect(ids(filterProjects(cards, { query: 'estoque', level: 'all' }, 'en'))).toEqual([]);
    expect(ids(filterProjects(cards, { query: 'assincronia', level: 'all' }, 'pt'))).toEqual(['SupportDesk']);
  });

  it.each([
    ['beginner', ['SupportDesk']],
    ['intermediate', ['Inventário']],
    ['advanced', ['Payments']],
  ] as const)('keeps only the %s projects', (level, expected) => {
    expect(ids(filterProjects(cards, { query: '', level }, 'en'))).toEqual(expected);
  });

  it('combines the search and the level', () => {
    expect(ids(filterProjects(cards, { query: 'a', level: 'advanced' }, 'en'))).toEqual(['Payments']);
    expect(ids(filterProjects(cards, { query: 'support', level: 'advanced' }, 'en'))).toEqual([]);
  });

  it('a project without details matches its id only, and no level', () => {
    expect(ids(filterProjects(cards, { query: 'gone', level: 'all' }, 'en'))).toEqual(['gone']);
    expect(ids(filterProjects(cards, { query: '', level: 'beginner' }, 'en'))).not.toContain('gone');
  });

  it('every tag must match, together with the text being typed', () => {
    expect(ids(filterProjects(cards, { query: '', tags: ['react', 'sqlite'], level: 'all' }, 'en'))).toEqual(['SupportDesk']);
    expect(ids(filterProjects(cards, { query: '', tags: ['react', 'fastapi'], level: 'all' }, 'en'))).toEqual([]);
    expect(ids(filterProjects(cards, { query: 'stock', tags: ['python'], level: 'all' }, 'en'))).toEqual(['Inventário']);
    expect(ids(filterProjects(cards, { query: '', tags: ['python'], level: 'beginner' }, 'en'))).toEqual([]);
  });
});
