/** The Projects screen's search and difficulty filter: they only hide cards, on the client. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { createProjectRepo } from '../helpers/project-repo.ts';
import { launch, supportdeskQa } from './fixtures.ts';

let dir: string;
let catalog: object[];

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-project-search-'));
  const easy = await createProjectRepo(dir, { front: 1, back: 0 }, 'Notes Board', 'easy', {
    difficulty: 'beginner',
    stack: { frontend: 'Elm · Parcel' },
    skills: { en: ['Pair debugging'], pt: ['Depuração em dupla'] },
  });
  const middle = await createProjectRepo(dir, { front: 1, back: 0 }, 'Inventário Geral', 'middle', { difficulty: 'intermediate' });
  const hard = await createProjectRepo(dir, { front: 1, back: 0 }, 'Ledger', 'hard', { difficulty: 'advanced' });
  catalog = [
    { id: 'supportdesk', qaDir: supportdeskQa, starter: true },
    { id: 'easy', qaDir: easy.qaDir },
    { id: 'middle', qaDir: middle.qaDir },
    { id: 'hard', qaDir: hard.qaDir },
  ];
});

test.afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function openProjects(language?: 'pt') {
  const launched = await launch({}, { env: { BUGDETECTIVE_DEV_SHOW_PROJECTS: 'true' }, catalog });
  await launched.page.getByTestId('start-playing').click();
  if (language) await launched.page.evaluate((value) => window.bugDetective.updateSettings({ language: value }), language);
  await launched.page.getByTestId('nav-projects').click();
  await expect(launched.page.getByTestId('project-easy-monogram')).toBeVisible();
  return launched;
}

const shown = (page: Page) => page.locator('[data-testid^="project-"][data-testid$="-flipper"]').evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')!.replace(/^project-|-flipper$/g, '')));

test('the search finds projects by name, stack and skill, ignoring case and accents, and counts them', async () => {
  const { page, close } = await openProjects();
  try {
    const search = page.getByRole('searchbox', { name: 'Search projects' });
    await expect(search).toHaveAttribute('placeholder', 'Search by name, stack or skill');
    await expect(page.getByTestId('project-count')).toHaveText('4 projects');
    await expect(page.getByTestId('project-count')).toHaveAttribute('role', 'status');

    for (const [query, expected] of [
      ['notes', ['easy']],
      ['parcel', ['easy']],
      ['pair debug', ['easy']],
      ['INVENTARIO', ['middle']],
      ['inventário', ['middle']],
    ] as const) {
      await search.fill(query);
      await expect.poll(() => shown(page)).toEqual(expected);
    }
    await expect(page.getByTestId('project-count')).toHaveText('1 project');
    // Esc empties the field.
    await search.press('Escape');
    await expect(search).toHaveValue('');
    await expect.poll(() => shown(page)).toHaveLength(4);
  } finally {
    await close();
  }
});

test('each difficulty option keeps its projects, and combines with the search', async () => {
  const { page, close } = await openProjects();
  try {
    await expect(page.getByTestId('project-level-beginner').locator('.bg-emerald-500')).toHaveCount(1);
    await expect(page.getByTestId('project-level-intermediate').locator('.bg-amber-500')).toHaveCount(1);
    await expect(page.getByTestId('project-level-advanced').locator('.bg-destructive')).toHaveCount(1);
    for (const [level, expected] of [
      ['beginner', ['supportdesk', 'easy']],
      ['intermediate', ['middle']],
      ['advanced', ['hard']],
      ['all', ['supportdesk', 'easy', 'middle', 'hard']],
    ] as const) {
      await page.getByTestId(`project-level-${level}`).click();
      await expect(page.getByTestId(`project-level-${level}`)).toHaveAttribute('aria-checked', 'true');
      await expect.poll(() => shown(page)).toEqual(expected);
    }
    // Arrow keys move between the options.
    await page.getByTestId('project-level-all').focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByTestId('project-level-beginner')).toBeFocused();
    await expect(page.getByTestId('project-level-beginner')).toHaveAttribute('aria-checked', 'true');

    await page.getByRole('searchbox').fill('notes');
    await expect.poll(() => shown(page)).toEqual(['easy']);
    // The filters never change the current project.
    await page.getByRole('searchbox').fill('');
    await expect(page.getByTestId('project-supportdesk').getByTestId('project-current')).toBeVisible();
    await expect(page.getByTestId('toast-info')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('no match shows the empty state, and "Clear filters" resets both controls and focuses the search', async () => {
  const { page, close } = await openProjects();
  try {
    await page.getByRole('searchbox').fill('ledger');
    await page.getByTestId('project-level-beginner').click();
    const empty = page.getByTestId('projects-empty');
    await expect(empty).toContainText('No projects match these filters');
    await expect(empty).toContainText('Try another search term or difficulty.');
    await expect(page.getByTestId('project-count')).toHaveText('0 projects');
    await empty.getByRole('button', { name: 'Clear filters' }).click();
    await expect(page.getByRole('searchbox')).toBeFocused();
    await expect(page.getByRole('searchbox')).toHaveValue('');
    await expect(page.getByTestId('project-level-all')).toHaveAttribute('aria-checked', 'true');
    await expect.poll(() => shown(page)).toHaveLength(4);

    // Leaving the screen and coming back resets the filters.
    await page.getByRole('searchbox').fill('ledger');
    await page.getByTestId('nav-dashboard').click();
    await page.getByTestId('nav-projects').click();
    await expect(page.getByRole('searchbox')).toHaveValue('');
  } finally {
    await close();
  }
});

test('in Portuguese the texts and the plural count follow the language', async () => {
  const { page, close } = await openProjects('pt');
  try {
    const search = page.getByRole('searchbox', { name: 'Buscar projetos' });
    await expect(search).toHaveAttribute('placeholder', 'Buscar por nome, stack ou habilidade');
    await expect(page.getByTestId('project-count')).toHaveText('4 projetos');
    await expect(page.getByTestId('project-level-all')).toHaveText('Todos');
    await expect(page.getByTestId('project-level-intermediate')).toHaveText('Intermediário');
    await search.fill('dupla');
    await expect(page.getByTestId('project-count')).toHaveText('1 projeto');
    await search.fill('zzz');
    await expect(page.getByTestId('projects-empty')).toContainText('Nenhum projeto corresponde aos filtros');
    await expect(page.getByTestId('projects-empty').getByRole('button')).toHaveText('Limpar filtros');
  } finally {
    await close();
  }
});
