import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { dragCard, launch, startFirstTicket } from './fixtures.ts';

/** Drops a card on a column it cannot go to and expects the explanation (drags occasionally get lost, so retry). */
async function dropExplains(page: Page, card: Locator, column: string, message: string) {
  await expect(async () => {
    await card.dragTo(page.getByTestId(`column-${column}`));
    await expect(page.getByTestId('toast-info').filter({ hasText: message })).not.toHaveCount(0, { timeout: 1000 });
  }).toPass({ timeout: 10_000 });
}

test('the player can only drag To Do → In Progress → In QA; QA and review move the rest', async () => {
  const { page, close } = await launch({ qa: ['gate2', 'passed'], qaDelayMs: 4000 });
  try {
    await startFirstTicket(page);
    const card = page.getByTestId('card-1');
    await expect(card).toHaveAttribute('data-status', 'todo');
    // The subtitle follows the column of the ticket being worked on.
    const hint = page.getByTestId('board-hint');
    await expect(hint).toHaveText('Move your ticket to In Progress and start your task.');

    // Forbidden drops are refused by the UI...
    for (const column of ['inQa', 'codeReview', 'done']) {
      await card.dragTo(page.getByTestId(`column-${column}`));
      await expect(page.getByTestId('toast-info').last()).toContainText('Only QA and the code review');
      await expect(card).toHaveAttribute('data-status', 'todo');
    }
    // ...and by the main process, even when the renderer asks directly.
    const direct = await page.evaluate(() => window.bugDetective.move(1, 'done').then(() => 'moved', (error: Error) => error.message));
    expect(direct).toContain('moveNotAllowed');

    await dragCard(page, 1, 'inProgress');
    await expect(card).toHaveAttribute('data-status', 'inProgress');
    await expect(hint).toHaveText("Move your ticket to In QA when the fix is ready. QA runs the project's tests first, then the ticket's own checks.");
    await dropExplains(page, card, 'todo', 'Tickets in progress cannot go back to To Do.');
    await expect(card).toHaveAttribute('data-status', 'inProgress');

    // In QA: the card cannot move while QA runs (a drop says QA will move it), then comes back with a comment.
    await dragCard(page, 1, 'inQa');
    await expect(card).toHaveAttribute('data-status', 'inQa');
    await dropExplains(page, card, 'done', 'Your card is being tested. When QA finishes, it moves the card to the right column.');
    await expect(card).toHaveAttribute('data-status', 'inQa');
    const cancel = await page.evaluate(() => window.bugDetective.move(1, 'inProgress').then(() => 'moved', (error: Error) => error.message));
    expect(cancel).toMatch(/moveNotAllowed|busy/);
    await expect(card).toHaveAttribute('data-status', 'inProgress', { timeout: 15_000 });
    await expect(card).toHaveAttribute('data-attempts', '1');

    // Second attempt passes: Code Review, then Done after accepting the review.
    await dragCard(page, 1, 'inQa');
    await expect(card).toHaveAttribute('data-status', 'codeReview', { timeout: 15_000 });
    await expect(hint).toHaveText('Review and accept the code review to move the ticket to Done.');
    for (const column of ['done', 'inProgress']) {
      await dropExplains(page, card, column, 'To move the card to Done, accept the code review.');
      await expect(card).toHaveAttribute('data-status', 'codeReview');
    }
    await card.click();
    await page.getByTestId('open-review').click();
    await expect(page.getByTestId('code-review')).toBeVisible();
    await expect(page.getByTestId('review-markdown')).toContainText('Why the bug happened');
    await expect(page.getByTestId('comparison')).toContainText('client/src/pages/TicketDetails.tsx');
    await page.getByTestId('accept-review').click();
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(card).toHaveAttribute('data-status', 'done');
    await expect(hint).toHaveText('Go back to the Dashboard and wait for your next assignment.');

    // One active ticket at a time: the next one is unlocked only now.
    await page.getByTestId('nav-dashboard').click();
    await expect(page.getByTestId('inbox-message')).toHaveCount(1 + 1);
    await page.getByTestId('next-assignment').click();
    await expect(page.getByTestId('card-2')).toHaveAttribute('data-status', 'todo');
    // A Done ticket next to an active one: the active one decides the subtitle.
    await expect(hint).toHaveText('Move your ticket to In Progress and start your task.');
    await expect(page.getByTestId('card-1')).toHaveAttribute('draggable', 'false');
    const reopen = await page.evaluate(() => window.bugDetective.move(1, 'inProgress').then(() => 'moved', (error: Error) => error.message));
    expect(reopen).toContain('notActiveTicket');
  } finally {
    await close();
  }
});

test('Get Next Assignment is unavailable until the current ticket is Done', async () => {
  const { page, close } = await launch();
  try {
    await startFirstTicket(page);
    await page.getByTestId('nav-dashboard').click();
    await expect(page.getByTestId('next-assignment')).toHaveCount(0);
    await expect(page.getByTestId('dashboard')).toContainText('Finish the current ticket');
    const result = await page.evaluate(() => window.bugDetective.nextAssignment().then(() => 'unlocked', (error: Error) => error.message));
    expect(result).toContain('ticketNotDone');
  } finally {
    await close();
  }
});

test('a QA timeout returns the card with the timeout template', async () => {
  const { page, close } = await launch({ qa: ['timeout'] });
  try {
    await startFirstTicket(page);
    const card = page.getByTestId('card-1');
    await dragCard(page, 1, 'inProgress');
    await dragCard(page, 1, 'inQa');
    await expect(card).toHaveAttribute('data-attempts', '1', { timeout: 15_000 });
    await expect(card).toHaveAttribute('data-status', 'inProgress');
    await card.click();
    await page.getByTestId('tab-qa').click();
    await expect(page.getByTestId('qa-comment').first()).toHaveAttribute('data-kind', 'timeout');
    await expect(page.getByTestId('qa-comment').first().locator('header')).toContainText('Test failed');
    await expect(page.getByTestId('qa-comment').first()).toContainText('180 seconds');
    await expect(page.getByTestId('qa-comment').first()).toContainText('Unfinished tests');
  } finally {
    await close();
  }
});

test('the dashboard shows only the current assignment, never how many tickets exist', async () => {
  const { page, close } = await launch();
  try {
    await page.getByTestId('start-playing').click();
    await expect(page.getByTestId('assignment-card')).toContainText('Queued');
    await expect(page.getByTestId('assignment-card').locator('h3').first()).toHaveText('Current task');
    // Right column: the current task, then the local environment, then the contacts.
    const order = await page.locator('[data-testid="assignment-card"], [data-testid="environment-card"], [data-testid="contacts-card"]').evaluateAll((cards) =>
      cards.map((card) => card.getAttribute('data-testid')),
    );
    expect(order).toEqual(['assignment-card', 'environment-card', 'contacts-card']);
    await expect(page.getByTestId('action-dock')).toContainText('Next action');
    await expect(page.getByTestId('dashboard')).not.toContainText(/\d+ of \d+/);

    await page.getByTestId('next-assignment').click();
    await page.getByTestId('card-1').waitFor();
    await page.getByTestId('nav-dashboard').click();
    await expect(page.getByTestId('assignment-card')).toContainText('SD-214');
    await expect(page.getByTestId('assignment-card').locator('[data-stage]')).toHaveAttribute('data-stage', 'todo');
    await expect(page.getByTestId('action-dock')).not.toContainText('player/');
    await expect(page.getByTestId('dashboard')).not.toContainText(/\d+ of \d+/);

    // The header has no inbox button: the Dashboard item carries the unread counter.
    await expect(page.getByTestId('header-inbox')).toHaveCount(0);

    // The header's language menu: the current flag opens one flag per language, no labels.
    const languageMenu = page.getByTestId('language-menu');
    await expect(languageMenu).toHaveText('');
    await expect(languageMenu).toHaveAttribute('aria-label', 'Language: English');
    await languageMenu.click();
    const options = page.getByTestId('language-options');
    await expect(options.getByRole('menuitemradio')).toHaveCount(2);
    await expect(options).toHaveText('');
    await expect(page.getByTestId('language-en')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('language-pt').click();
    await expect(options).toHaveCount(0);
    await expect(page.getByTestId('nav-board')).toHaveText('Quadro');
    await expect(languageMenu).toHaveAttribute('aria-label', 'Idioma: Português (Brasil)');
    await languageMenu.click();
    await page.keyboard.press('Escape');
    await expect(options).toHaveCount(0);
    await languageMenu.click();
    await page.getByTestId('language-en').click();
    await expect(page.getByTestId('nav-board')).toHaveText('Board');

    // The header's theme toggle switches the theme everywhere.
    const dark = () => page.evaluate(() => document.documentElement.classList.contains('dark'));
    const before = await dark();
    // An icon-only toggle: the sun in the light theme, the moon in the dark one.
    const toggle = page.getByTestId('theme-toggle');
    await expect(toggle).toHaveText('');
    await expect(toggle).toHaveAttribute('aria-label', 'Switch between the light and dark theme');
    await expect(toggle).toHaveAttribute('data-theme', before ? 'dark' : 'light');
    await toggle.click();
    await expect.poll(dark).toBe(!before);
    await expect(toggle).toHaveAttribute('data-theme', before ? 'light' : 'dark');
    // Native controls and scrollbars follow the theme.
    const scheme = () => page.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
    await expect.poll(scheme).toBe(before ? 'light' : 'dark');
    expect(await page.evaluate(() => getComputedStyle(document.documentElement, '::-webkit-scrollbar-button').display)).toBe('none');
  } finally {
    await close();
  }
});

test('the project context card collapses and remembers it after a restart', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'João Silva e2e-'));
  try {
    const first = await launch({}, { userData });
    await first.page.getByTestId('start-playing').click();
    const card = first.page.getByTestId('project-context');
    const toggle = first.page.getByTestId('project-context-toggle');
    await expect(toggle).toHaveText('Project context');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(card).toContainText('Lanternfish Labs');
    await expect(card).toContainText('Harborline Outfitters');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(card).not.toContainText('Harborline Outfitters');
    await first.close();

    const second = await launch({}, { userData });
    try {
      await second.page.getByTestId('start-playing').click();
      const again = second.page.getByTestId('project-context-toggle');
      await expect(again).toHaveAttribute('aria-expanded', 'false');
      await again.click();
      await expect(second.page.getByTestId('project-context')).toContainText('Harborline Outfitters');
    } finally {
      await second.close();
    }
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test('the columns are framed cards with a placeholder when empty, in English and Portuguese', async () => {
  const { page, close } = await launch();
  try {
    await startFirstTicket(page);
    await expect(page.getByTestId('board-hint')).toHaveText('Move your ticket to In Progress and start your task.');
    const column = page.getByTestId('column-inQa');
    await expect(column).toHaveAttribute('aria-label', 'In QA');
    await expect(column).toHaveClass(/rounded-xl/);
    await expect(column.locator('header')).toHaveClass(/bg-amber-500\/10/);
    await expect(page.getByTestId('count-todo')).toHaveText('1');
    await expect(page.getByTestId('empty-todo')).toHaveCount(0);
    const empty = {
      inProgress: 'Drag your ticket here when you start working on it.',
      inQa: 'Drop your ticket here to run QA.',
      codeReview: 'Tickets that pass QA wait here for review.',
      done: 'Tickets land here once you accept their review.',
    };
    for (const [id, text] of Object.entries(empty)) {
      await expect(page.getByTestId(`empty-${id}`)).toHaveText(text);
    }
    await expect(page.getByTestId('empty-inQa')).toHaveClass(/border-amber-500\/40/);

    // A placeholder is still a drop target.
    await dragCard(page, 1, 'inProgress');
    await expect(page.getByTestId('empty-todo')).toHaveText('Nothing waiting. New assignments arrive in your inbox.');
    await expect(page.getByTestId('empty-inProgress')).toHaveCount(0);

    await page.evaluate(() => window.bugDetective.updateSettings({ language: 'pt' }));
    await expect(page.getByTestId('board-hint')).toHaveText(
      'Mova seu ticket para Em QA quando a correção estiver pronta. O QA roda primeiro os testes do projeto e depois as verificações do ticket.',
    );
    await expect(page.getByTestId('empty-todo')).toHaveText('Nada esperando. Novas tarefas chegam na sua caixa de entrada.');
    await expect(page.getByTestId('empty-inQa')).toHaveText('Solte seu ticket aqui para rodar o QA.');
    await expect(page.getByTestId('empty-codeReview')).toHaveText('Tickets aprovados no QA aguardam revisão aqui.');
    await expect(page.getByTestId('empty-done')).toHaveText('Os tickets chegam aqui quando você aceita a revisão.');
    await dropExplains(page, page.getByTestId('card-1'), 'todo', 'Tarefas em andamento não podem voltar para a coluna A fazer.');
  } finally {
    await close();
  }
});

test('a card shows only its key and title, and "Test failed" only after a failed QA run', async () => {
  const { page, close } = await launch({ qa: ['gate2', 'passed'], qaDelayMs: 1500 });
  try {
    await startFirstTicket(page);
    const card = page.getByTestId('card-1');
    await expect(card).toHaveText(/^SD-214/);
    await expect(card.getByTestId('card-qa-failed')).toHaveCount(0);
    await dragCard(page, 1, 'inProgress');
    await expect(card).toHaveClass(/border-primary\/40/);
    await expect(page.getByTestId('board').getByRole('button', { name: /VS Code|Browser/ })).toHaveCount(0);

    await dragCard(page, 1, 'inQa');
    // While QA runs, a "Testing" tag with a spinner sits next to the key; it goes away with the result.
    await expect(card.getByTestId('card-qa-running')).toHaveText('Testing');
    await expect(card.getByTestId('card-qa-running').locator('svg')).toBeVisible();
    await expect(card).toHaveAttribute('data-attempts', '1', { timeout: 15_000 });
    await expect(card).toHaveAttribute('data-status', 'inProgress');
    await expect(card.getByTestId('card-qa-running')).toHaveCount(0);
    await expect(card.getByTestId('card-qa-failed')).toHaveText('Test failed');

    // A new run replaces the failure; once it passes the badge is gone, and no "Tests passed" badge appears.
    await dragCard(page, 1, 'inQa');
    await expect(card).toHaveAttribute('data-status', 'codeReview', { timeout: 15_000 });
    await expect(card.getByTestId('card-qa-failed')).toHaveCount(0);
    await expect(card).not.toContainText('Tests passed');
  } finally {
    await close();
  }
});

test('the inbox shows at most three messages, and the dashboard fits the window with the project context and the e-mail scrolling', async () => {
  const { page, close } = await launch();
  try {
    // The window's minimum size (minHeight in src/main/index.ts).
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.getByTestId('start-playing').click();
    const inbox = page.getByTestId('inbox');
    await expect(page.getByTestId('inbox-message')).toHaveCount(1);
    await expect.poll(() => inbox.evaluate((list) => list.scrollHeight > list.clientHeight)).toBe(false);

    // Five messages (copies of the first, outside React): exactly three fit, the rest scroll.
    const fit = await inbox.evaluate((list) => {
      const item = list.querySelector('li')!;
      for (let index = 0; index < 4; index += 1) list.append(item.cloneNode(true));
      const third = list.querySelectorAll('li')[2]!.getBoundingClientRect();
      return { scrolls: list.scrollHeight > list.clientHeight, visible: list.clientHeight, threeTall: third.bottom - list.getBoundingClientRect().top };
    });
    expect(fit.scrolls).toBe(true);
    expect(Math.abs(fit.visible - fit.threeTall)).toBeLessThanOrEqual(2);

    // The dashboard is at most the window tall: the page does not scroll, the project context and the e-mail do.
    const main = page.locator('main');
    await expect.poll(() => main.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
    for (const id of ['project-context', 'message', 'action-dock']) {
      const bottom = await page.getByTestId(id).evaluate((element) => element.getBoundingClientRect().bottom);
      expect(bottom).toBeLessThanOrEqual(700);
    }
    const scrolls = (id: string) => page.getByTestId(id).evaluate((element) => element.scrollHeight > element.clientHeight);
    await expect.poll(() => scrolls('project-context-body')).toBe(true);
    await expect.poll(() => scrolls('message-scroll')).toBe(true);
    // The sender header stays outside the scrolling e-mail, and the e-mail shows no message ID.
    await expect(page.getByTestId('message').locator('> header')).toContainText('Rafaela Nunes');
    await expect(page.getByTestId('message-scroll').locator('header')).toHaveCount(0);
    await expect(page.getByTestId('message')).not.toContainText('msg-');
  } finally {
    await close();
  }
});

test('Local environment always lists Docker, both images and the dependencies, with their state', async () => {
  const rows = ['env-docker', 'env-workspaceImage', 'env-qaImage', 'env-projectDependencies'];
  const { page, close } = await launch({ stopDockerAfterUnlock: true });
  try {
    // Before the first ticket the card asks for the report itself: nothing waits for an unlock.
    await page.getByTestId('start-playing').click();
    const card = page.getByTestId('environment-card');
    for (const row of rows) await expect(card.getByTestId(row)).toBeVisible();
    await expect(card.getByTestId('env-docker')).toContainText('Running');
    await expect(card.getByTestId('env-workspaceImage')).toContainText('Ready (1.1 GB)');
    await expect(card.getByTestId('env-qaImage')).toContainText('Ready (3 GB)');
    await expect(card.getByTestId('env-projectDependencies')).toContainText('Not installed yet');

    // Docker stops: every row stays, Docker with its stopped state.
    await page.getByTestId('next-assignment').click();
    await expect(page.getByTestId('docker-banner')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('nav-dashboard').click();
    for (const row of rows) await expect(card.getByTestId(row)).toBeVisible();
    await expect(card.getByTestId('env-docker')).toContainText('Stopped');
  } finally {
    await close();
  }
});

test('an unread message that is shown open counts as read, without clicking it', async () => {
  const { page, close } = await launch({ qa: ['passed'] });
  try {
    // The welcome message opens on its own: the header counter clears.
    await page.getByTestId('start-playing').click();
    await expect(page.getByTestId('inbox-message')).toHaveCount(1);
    await expect(page.getByTestId('unread-count')).toHaveCount(0);

    // A new directive arrives while the player is on the Board (after accepting the review)...
    await page.getByTestId('next-assignment').click();
    await page.getByTestId('card-1').waitFor();
    await dragCard(page, 1, 'inProgress');
    await dragCard(page, 1, 'inQa');
    await expect(page.getByTestId('card-1')).toHaveAttribute('data-status', 'codeReview', { timeout: 15_000 });
    await page.getByTestId('card-1').click();
    await page.getByTestId('open-review').click();
    await page.getByTestId('accept-review').click();
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('nav-dashboard').getByTestId('unread-count')).toHaveText('1');
    // ...and opening the Dashboard shows it open, which marks it read.
    await page.getByTestId('nav-dashboard').click();
    await expect(page.getByTestId('dashboard')).toBeVisible();
    await expect(page.getByTestId('unread-count')).toHaveCount(0);
  } finally {
    await close();
  }
});
