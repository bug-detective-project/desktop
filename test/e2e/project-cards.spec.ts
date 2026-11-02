/**
 * The Projects screen's flip cards: the front (monogram, difficulty, the current project, tickets,
 * description and actions) and the brief on the back (client, stack, tickets and skills).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { createProjectRepo } from '../helpers/project-repo.ts';
import { launch, supportdeskQa, takeNextTicket } from './fixtures.ts';

const showProjects = { BUGDETECTIVE_DEV_SHOW_PROJECTS: 'true' };
let dir: string;
let catalog: object[];

test.beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-project-cards-'));
  const easy = await createProjectRepo(dir, { front: 2, back: 1 }, 'Notes Board', 'easy', {
    difficulty: 'beginner',
    stack: { frontend: 'React · Vite' },
    skills: { en: ['Async and state', 'Tracing data flow'], pt: ['Assincronia e estado', 'Rastrear o fluxo de dados'] },
  });
  const middle = await createProjectRepo(dir, { front: 1, back: 1 }, 'Middle', 'middle', { difficulty: 'intermediate' });
  const hard = await createProjectRepo(dir, { front: 1, back: 0 }, 'Hard', 'hard', { difficulty: 'advanced' });
  catalog = [
    { id: 'supportdesk', qaDir: supportdeskQa, starter: true },
    { id: 'easy', qaDir: easy.qaDir },
    { id: 'middle', qaDir: middle.qaDir },
    { id: 'hard', qaDir: hard.qaDir },
    // Never downloaded: its folder does not exist.
    { id: 'gone', qaDir: join(dir, 'gone-qa') },
  ];
});

test.afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function openProjects(options: { language?: 'pt' } = {}): Promise<{ app: ElectronApplication; page: Page; close: () => Promise<void> }> {
  const launched = await launch({}, { env: showProjects, catalog });
  await launched.page.getByTestId('start-playing').click();
  if (options.language) {
    await launched.page.evaluate((language) => window.bugDetective.updateSettings({ language }), options.language);
  }
  await launched.page.getByTestId('nav-projects').click();
  await expect(launched.page.getByTestId('project-easy').getByTestId('project-tickets').first()).toBeVisible();
  return launched;
}

test('a project card flips to its brief and back from its buttons, moving the focus and hiding the other face', async () => {
  const { page, close } = await openProjects();
  try {
    const card = page.getByTestId('project-easy');
    await expect(card).toHaveCSS('height', '380px');
    await expect(card).toHaveCSS('width', '450px');
    const front = page.getByTestId('project-easy-front');
    const back = page.getByTestId('project-easy-back');
    await expect(back).toHaveAttribute('aria-hidden', 'true');
    await expect(back).toHaveAttribute('inert', '');
    // A click on the card itself does not flip it.
    await card.getByRole('heading', { name: 'Notes Board' }).click();
    await expect(back).toHaveAttribute('aria-hidden', 'true');

    await page.getByTestId('project-easy-brief').click();
    await expect(page.getByTestId('project-easy-close-brief')).toBeFocused();
    await expect(front).toHaveAttribute('aria-hidden', 'true');
    await expect(front).toHaveAttribute('inert', '');
    await expect(back).not.toHaveAttribute('aria-hidden', 'true');
    // The hidden front takes no focus: its "Play" button cannot be reached.
    await page.getByTestId('switch-easy').focus();
    await expect(page.getByTestId('switch-easy')).not.toBeFocused();

    await page.getByTestId('project-easy-close-brief').click();
    await expect(page.getByTestId('project-easy-brief')).toBeFocused();
    await expect(back).toHaveAttribute('inert', '');

    // Leaving the screen and coming back shows the fronts.
    await page.getByTestId('project-easy-brief').click();
    await page.getByTestId('nav-dashboard').click();
    await page.getByTestId('nav-projects').click();
    await expect(page.getByTestId('project-easy-back')).toHaveAttribute('aria-hidden', 'true');
  } finally {
    await close();
  }
});

test('the brief shows the client, the stack that exists, the tickets and the skills, and leaves out what is missing', async () => {
  const { page, close } = await openProjects();
  try {
    await page.getByTestId('project-easy-brief').click();
    const back = page.getByTestId('project-easy-back');
    await expect(back.getByTestId('project-client')).toHaveText('Client: Client');
    await expect(back.getByTestId('project-stack-frontend')).toContainText('React · Vite');
    await expect(back.getByTestId('project-stack-backend')).toHaveCount(0);
    await expect(back.getByTestId('project-stack-database')).toHaveCount(0);
    await expect(back.getByTestId('project-tickets')).toContainText('Front 2 · Back 1');
    await expect(back.getByTestId('project-skills').getByRole('listitem')).toHaveText(['Async and state', 'Tracing data flow']);
    await expect(back.getByTestId(/^switch-/)).toHaveCount(0);

    await page.getByTestId('project-middle-brief').click();
    await expect(page.getByTestId('project-middle-back').getByTestId('project-skills')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('the front shows the monogram, the difficulty in its color, the badge only on the current project and Play only on the others', async () => {
  const { page, close } = await openProjects();
  try {
    await expect(page.getByTestId('project-easy-monogram')).toHaveText('NB');
    const levels = { easy: ['beginner', 1, 'bg-emerald-500'], middle: ['intermediate', 2, 'bg-amber-500'], hard: ['advanced', 3, 'bg-destructive'] } as const;
    for (const [id, [level, filled, color]] of Object.entries(levels)) {
      const meter = page.getByTestId(`project-${id}`).getByTestId('project-difficulty');
      await expect(meter).toHaveAttribute('data-level', level);
      await expect(meter.getByRole('img')).toHaveAttribute('aria-label', level[0].toUpperCase() + level.slice(1));
      await expect(meter.locator(`.${color}`)).toHaveCount(filled);
      await expect(meter.locator('.bg-border')).toHaveCount(3 - filled);
    }
    await expect(page.getByTestId('project-current')).toHaveCount(1);
    await expect(page.getByTestId('project-supportdesk').getByTestId('project-current')).toHaveText('Current project');
    await expect(page.getByTestId('switch-supportdesk')).toHaveCount(0);
    for (const id of ['easy', 'middle', 'hard']) {
      await expect(page.getByTestId(`switch-${id}`)).toHaveText('Play this project');
    }
    await expect(page.getByTestId('project-easy').getByTestId('project-tickets').first()).toHaveText('Front 2 · Back 1');
    // No technology tags on the front.
    await expect(page.getByTestId('project-easy-front')).not.toContainText('React · Vite');
  } finally {
    await close();
  }
});

test('a project without details cannot open its brief, and can still be played', async () => {
  const { page, close } = await openProjects();
  try {
    const card = page.getByTestId('project-gone');
    await expect(card).toContainText('Connect to the internet to see the details.');
    await expect(page.getByTestId('project-gone-brief')).toBeDisabled();
    await expect(page.getByTestId('switch-gone')).toBeEnabled();
  } finally {
    await close();
  }
});

test('with reduced motion the faces swap without animation', async () => {
  const { page, close } = await openProjects();
  try {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.getByTestId('project-easy-flipper')).toHaveCSS('transition-duration', '0s');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(page.getByTestId('project-easy-flipper')).toHaveCSS('transition-duration', '0.45s');
  } finally {
    await close();
  }
});

test('in Portuguese the buttons stay on one line in a 1280 px window', async () => {
  const { app, page, close } = await openProjects({ language: 'pt' });
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 640));
    await expect.poll(() => page.evaluate(() => window.innerWidth)).toBe(1280);
    await expect(page.getByTestId('project-easy-brief')).toHaveText('Ler o briefing');
    await expect(page.getByTestId('switch-easy')).toHaveText('Jogar este projeto');
    for (const id of ['project-easy-brief', 'switch-easy']) {
      const box = (await page.getByTestId(id).boundingBox())!;
      expect(box.height).toBeLessThan(44);
    }
    await page.getByTestId('project-easy-brief').click();
    await expect(page.getByTestId('project-easy-back').getByTestId('project-client')).toHaveText('Cliente: Client');
    await expect(page.getByTestId('project-easy-close-brief')).toHaveAttribute('aria-label', 'Fechar o briefing');
  } finally {
    await close();
  }
});

test('"Play this project" keeps the switch flow: the confirmation, the backup offer, Cancel, and the switch itself', async () => {
  const { page, close } = await openProjects();
  try {
    await page.getByTestId('switch-easy').click();
    const dialog = page.getByTestId('switch-dialog');
    await expect(dialog.getByRole('heading')).toHaveText('Switch to Notes Board?');
    await expect(dialog.getByTestId('switch-export')).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId('project-supportdesk').getByTestId('project-current')).toBeVisible();

    await page.getByTestId('switch-easy').click();
    await page.getByTestId('confirm-switch').click();
    await expect(page.getByTestId('toast-info')).toHaveText('Notes Board is your project now.');
    await expect(page.getByTestId('project-easy').getByTestId('project-current')).toBeVisible();
    await expect(page.getByTestId('switch-easy')).toHaveCount(0);
    await expect(page.getByTestId('switch-supportdesk')).toBeEnabled();
  } finally {
    await close();
  }
});

test('with a ticket open, "Play this project" is disabled and the card says why', async () => {
  const { page, close } = await openProjects();
  try {
    await page.getByTestId('nav-dashboard').click();
    await takeNextTicket(page);
    await page.getByTestId('card-1').waitFor();
    await page.getByTestId('nav-projects').click();
    await expect(page.getByTestId('switch-easy')).toBeDisabled();
    await expect(page.getByTestId('project-easy-front')).toContainText('Finish the open ticket first.');
  } finally {
    await close();
  }
});
