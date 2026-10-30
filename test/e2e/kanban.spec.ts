import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { dragCard, expectFlagsLoaded, launch, simulate, startFirstTicket } from './fixtures.ts';

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
    await expect(page.getByTestId('dashboard')).not.toContainText('Finish the current ticket');
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
    const task = page.getByTestId('assignment-card');
    await expect(task).toHaveAttribute('data-state', 'queued');
    await expect(task).toContainText('Backlog');
    await expect(task).toContainText('Your next ticket is ready to download.');
    await expect(task.locator('h3').first()).toHaveText('Current task');
    // The work desk: the current task, then the local environment, then the drawer button; the action lives only here.
    const desk = page.getByTestId('work-desk');
    await expect(desk).toHaveAttribute('aria-label', 'Your desk');
    const order = await desk.locator('[data-testid="assignment-card"], [data-testid="environment-card"], [data-testid="project-drawer-toggle"]').evaluateAll((items) =>
      items.map((item) => item.getAttribute('data-testid')),
    );
    expect(order).toEqual(['assignment-card', 'environment-card', 'project-drawer-toggle']);
    // Below Local environment: the client.
    await expect(page.getByTestId('desk-client')).toHaveText(/Client\s*Harborline Outfitters/);
    const below = await page.evaluate(() => {
      const top = (id: string) => document.querySelector(`[data-testid="${id}"]`)!.getBoundingClientRect().top;
      return top('desk-client') > top('environment-card');
    });
    expect(below).toBe(true);
    await expect(page.getByTestId('next-assignment')).toHaveCount(1);
    // The e-mail ends with the same next step, which unlocks the ticket too.
    await expect(page.getByTestId('email-next')).toContainText('Next action: get your next assignment');
    await expect(page.getByTestId('email-next-assignment')).toBeEnabled();
    await expect(page.getByTestId('dashboard')).not.toContainText(/\d+ of \d+/);

    await page.getByTestId('email-next-assignment').click();
    await page.getByTestId('card-1').waitFor();
    await page.getByTestId('nav-dashboard').click();
    await expect(task).toHaveAttribute('data-state', 'active');
    // Only while the next assignment waits: an active ticket has its action on the desk alone.
    await expect(page.getByTestId('email-next')).toHaveCount(0);
    await expect(task).toContainText('SD-214');
    // The client is its own desk section, not a line of the task.
    await expect(task).not.toContainText('Harborline');
    // The stage pill sits on the "Current task" line, on the right.
    const labelLine = task.locator('[data-stage]').locator('xpath=ancestor::div[1]');
    await expect(labelLine).toContainText('Current task');
    await expect(task.locator('[data-stage]')).toHaveAttribute('data-stage', 'todo');
    // To Do gets a still gray dot in the current task's pill.
    await expect(task.locator('[data-stage] > span.bg-slate-400')).toHaveCount(1);
    await expect(task.locator('[data-stage] > span.bg-slate-400')).not.toHaveClass(/animate-pulse/);
    // The primary action and, while a ticket is active, VS Code and Browser with their full labels as tooltips.
    await expect(page.getByTestId('desk-primary')).toHaveText('Start ticket on Board');
    await expect(page.getByTestId('desk-vscode')).toHaveAttribute('title', 'Open in VS Code');
    // The current task is a full-bleed tinted block, the desk's first child, with its label in primary;
    // VS Code and Browser keep a card surface on the tint.
    expect(await desk.evaluate((element) => element.firstElementChild?.getAttribute('data-testid'))).toBe('assignment-card');
    await expect(task).toHaveClass(/border-primary\/25/);
    await expect(task.locator('h3')).toHaveClass(/text-primary/);
    await expect(page.getByTestId('desk-vscode')).toHaveClass(/bg-card/);
    await expect(page.getByTestId('desk-browser')).toHaveClass(/bg-card/);
    await expect(page.getByTestId('desk-browser')).toHaveAttribute('title', 'Open app in browser');
    await expect(desk).not.toContainText('player/');
    await page.getByTestId('desk-primary').click();
    await expect(page.getByTestId('ticket-panel')).toBeVisible();
    await page.getByTestId('close-panel').click();
    await page.getByTestId('nav-dashboard').click();
    await expect(page.getByTestId('dashboard')).not.toContainText(/\d+ of \d+/);

    // The header has no inbox button: the Dashboard item carries the unread counter.
    await expect(page.getByTestId('header-inbox')).toHaveCount(0);

    // The header's language menu: the current flag opens one flag per language, no labels.
    const languageMenu = page.getByTestId('language-menu');
    await expect(languageMenu).toHaveText('');
    await expect(languageMenu).toHaveAttribute('aria-label', 'Language: English');
    await expectFlagsLoaded(languageMenu, ['en']);
    await languageMenu.click();
    const options = page.getByTestId('language-options');
    await expect(options.getByRole('menuitemradio')).toHaveCount(2);
    await expect(options).toHaveText('');
    await expect(page.getByTestId('language-en')).toHaveAttribute('aria-checked', 'true');
    await expectFlagsLoaded(options, ['en', 'pt']);
    await page.getByTestId('language-pt').click();
    await expect(options).toHaveCount(0);
    await expect(page.getByTestId('nav-board')).toHaveText('Quadro');
    await expect(languageMenu).toHaveAttribute('aria-label', 'Idioma: Português (Brasil)');
    await expectFlagsLoaded(languageMenu, ['pt']);
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

test('Project & contacts opens in a drawer: closed by default, closes with the button, Escape or the backdrop, and keeps focus right', async () => {
  const { page, close } = await launch();
  try {
    await page.getByTestId('start-playing').click();
    const toggle = page.getByTestId('project-drawer-toggle');
    const drawer = page.getByTestId('project-drawer');
    await expect(drawer).toHaveCount(0);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAttribute('aria-controls', 'project-drawer');

    await toggle.click();
    await expect(drawer).toBeVisible();
    await expect(drawer).toHaveAttribute('role', 'dialog');
    await expect(drawer).toHaveAccessibleName('Project & contacts');
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(page.getByTestId('project-drawer-close')).toBeFocused();
    await expect(page.getByTestId('project-context')).toContainText('Lanternfish Labs');
    await expect(page.getByTestId('project-context')).toContainText('Your team');
    await expect(page.getByTestId('project-context')).toContainText('Harborline Outfitters');
    await expect(page.getByTestId('project-context')).toContainText('Client');
    // The hint mentor comes first in Contacts, with the mentor badge.
    await expect(page.getByTestId('contacts-card').locator('li').first()).toContainText('Priya Raman');
    await expect(page.getByTestId('contacts-card').locator('li').first()).toContainText('Hints mentor');
    // Then the manager, on the player's own team.
    await expect(page.getByTestId('contacts-card').locator('li').nth(1)).toContainText('Rafaela Nunes');
    await expect(page.getByTestId('contacts-card').locator('li').nth(1)).toContainText('Engineering manager · Lanternfish Labs');

    // Escape closes and gives the focus back to the desk button.
    await page.keyboard.press('Escape');
    await expect(drawer).toHaveCount(0);
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');

    // The close button and a click on the backdrop close it too.
    await toggle.click();
    await page.getByTestId('project-drawer-close').click();
    await expect(drawer).toHaveCount(0);
    await expect(toggle).toBeFocused();
    // The drawer opens on the side of the window, like the ticket panel, over a backdrop that covers it all.
    await toggle.click();
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    // Measured once the 150ms slide-in is over.
    await expect
      .poll(async () => {
        const box = (await drawer.boundingBox())!;
        return [Math.round(box.x + box.width), Math.round(box.y), Math.round(box.height)];
      })
      .toEqual([viewport.width, 0, viewport.height]);
    await page.getByTestId('project-drawer-backdrop').click({ position: { x: 20, y: 20 } });
    await expect(drawer).toHaveCount(0);

    // Kept open for the session: a reload keeps it open.
    await toggle.click();
    await page.reload();
    await page.getByTestId('start-playing').click();
    await expect(drawer).toBeVisible();
  } finally {
    await close();
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

test('the dashboard is one card with three panes that fit the window and scroll on their own, in English and Portuguese', async () => {
  const { page, close } = await launch();
  try {
    // The window's minimum height (minHeight in src/main/index.ts).
    await page.setViewportSize({ width: 1440, height: 700 });
    await page.getByTestId('start-playing').click();
    const panes = await page.evaluate(() => {
      const desk = document.querySelector('[data-testid="work-desk"]')!.getBoundingClientRect();
      const inbox = document.querySelector('[data-testid="inbox"]')!.parentElement!.getBoundingClientRect();
      const message = document.querySelector('[data-testid="message"]')!.getBoundingClientRect();
      return { desk: desk.width, inbox: inbox.width, message: message.width, sameTop: desk.top === inbox.top && inbox.top === message.top };
    });
    expect(panes).toMatchObject({ desk: 320, inbox: 400, sameTop: true });
    expect(panes.message).toBeGreaterThan(400);

    // The page never scrolls: the inbox list and the e-mail do, each on its own.
    const main = page.locator('main');
    await expect.poll(() => main.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);
    const scrolls = (id: string) => page.getByTestId(id).evaluate((element) => element.scrollHeight > element.clientHeight);
    await expect.poll(() => scrolls('message')).toBe(true);
    await page.getByTestId('inbox').evaluate((list) => {
      const item = list.querySelector('li')!;
      for (let index = 0; index < 8; index += 1) list.append(item.cloneNode(true));
    });
    await expect.poll(() => scrolls('inbox')).toBe(true);
    await expect.poll(() => main.evaluate((element) => element.scrollHeight <= element.clientHeight)).toBe(true);

    // The e-mail: subject, sender with address, "to you · role", the date; no message ID and no action.
    const message = page.getByTestId('message');
    await expect(message.locator('h1')).toHaveText('Welcome to Lanternfish Labs!');
    await expect(message.locator('header')).toContainText('rafaela@lanternfish.labs');
    await expect(message.locator('header')).toContainText('Engineering manager');
    await expect(message.locator('header')).not.toContainText('to you');
    await expect(message).not.toContainText('msg-');

    // No button in the dashboard wraps, in either language.
    for (const language of ['en', 'pt'] as const) {
      await page.evaluate((value) => window.bugDetective.updateSettings({ language: value }), language);
      await expect(page.getByTestId('nav-board')).toHaveText(language === 'en' ? 'Board' : 'Quadro');
      const wrapped = await page.getByTestId('dashboard').locator('button').evaluateAll((buttons) =>
        buttons.filter((button) => getComputedStyle(button).whiteSpace !== 'nowrap' && button.closest('[data-testid="inbox"]') === null).map((button) => button.textContent),
      );
      expect(wrapped).toEqual([]);
    }
    await expect(page.getByTestId('work-desk')).toHaveAttribute('aria-label', 'Sua mesa');
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
    await expect(card.getByTestId('env-workspaceImage')).toContainText('Ready · 1.1 GB');
    await expect(card.getByTestId('env-qaImage')).toContainText('Ready · 3 GB');
    await expect(card.getByTestId('env-projectDependencies')).toContainText('Not installed yet');
    // No summary badge: the title is green while everything works, red on a problem.
    await expect(card).toHaveAttribute('data-tone', 'ok');
    await expect(card.getByRole('heading')).toHaveClass(/text-emerald-600/);
    await expect(card).not.toContainText('All set');

    // Docker stops: every row stays, Docker with its stopped state.
    await page.getByTestId('next-assignment').click();
    await expect(page.getByTestId('docker-banner')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('nav-dashboard').click();
    for (const row of rows) await expect(card.getByTestId(row)).toBeVisible();
    await expect(card.getByTestId('env-docker')).toContainText('Stopped');
    await expect(card.getByTestId('env-docker')).toHaveAttribute('data-tone', 'danger');
    await expect(card).toHaveAttribute('data-tone', 'danger');
    await expect(card.getByRole('heading')).toHaveClass(/text-destructive/);
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
    // Done: a toast sends the player to the Dashboard, where a red "1" marks the next task (it wins over the unread count).
    await expect(page.getByTestId('toast-info').last()).toContainText('Go to the Dashboard to get your next task');
    await expect(page.getByTestId('nav-dashboard').getByTestId('pending-count')).toHaveText('1');
    await expect(page.getByTestId('unread-count')).toHaveCount(0);
    // ...and opening the Dashboard shows the message open, which marks it read; the red badge stays until the next task is taken.
    await page.getByTestId('nav-dashboard').click();
    await expect(page.getByTestId('dashboard')).toBeVisible();
    await expect(page.getByTestId('unread-count')).toHaveCount(0);
    await expect(page.getByTestId('pending-count')).toHaveText('1');
    await page.getByTestId('next-assignment').click();
    await expect(page.getByTestId('pending-count')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('"Solve bug" shows on the card in progress only when BUGDETECTIVE_DEV_SOLVE_BUG_BUTTON is on', async () => {
  const off = await launch();
  try {
    await startFirstTicket(off.page);
    await dragCard(off.page, 1, 'inProgress');
    await expect(off.page.getByTestId('solve-bug')).toHaveCount(0);
  } finally {
    await off.close();
  }

  const { page, close } = await launch({}, { env: { BUGDETECTIVE_DEV_SOLVE_BUG_BUTTON: 'true' } });
  try {
    await startFirstTicket(page);
    await expect(page.getByTestId('solve-bug')).toHaveCount(0);
    await dragCard(page, 1, 'inProgress');
    await page.getByTestId('solve-bug').click();
    await expect(page.getByTestId('toast-info').last()).toContainText('reference fix is now in your code');
    // The click stays on the button: the ticket panel does not open.
    await expect(page.getByTestId('ticket-panel')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('cards have a Move button in To Do and In Progress, and a Review button in Code Review', async () => {
  const { page, close } = await launch({ qa: ['passed'] });
  try {
    await startFirstTicket(page);
    const card = page.getByTestId('card-1');
    await card.getByTestId('move-card').click();
    await expect(card).toHaveAttribute('data-status', 'inProgress');
    // The click stays on the button: the ticket panel does not open.
    await expect(page.getByTestId('ticket-panel')).toHaveCount(0);
    await card.getByTestId('move-card').click();
    await expect(card).toHaveAttribute('data-status', 'codeReview', { timeout: 15_000 });
    await expect(card.getByTestId('move-card')).toHaveCount(0);
    await card.getByTestId('review-card').click();
    await expect(page.getByTestId('code-review')).toBeVisible();
    await expect(page.getByTestId('ticket-panel')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('the work desk shows the downloads first, with the install log, then the queued assignment', async () => {
  const { page, close } = await launch({ environmentReady: false });
  try {
    await page.getByTestId('start-playing').click();
    const task = page.getByTestId('environment-panel');
    await expect(task).toHaveAttribute('data-state', 'download');
    await expect(task).toContainText('Download the game environment to continue.');
    await expect(page.getByTestId('next-assignment')).toHaveCount(0);
    const card = page.getByTestId('environment-card');
    await expect(card.getByTestId('env-workspaceImage')).toHaveAttribute('data-tone', 'danger');
    await expect(card.getByTestId('env-workspaceImage')).toContainText('Missing');
    await expect(card).toHaveAttribute('data-tone', 'danger');
    await expect(card.getByRole('heading')).toHaveClass(/text-destructive/);

    await page.getByTestId('install-environment').click();
    await expect(page.getByTestId('environment-panel')).toHaveCount(0);
    await expect(page.getByTestId('assignment-card')).toHaveAttribute('data-state', 'queued');
    await expect(card.getByTestId('env-workspaceImage')).toContainText('Ready · 1.1 GB');
    await expect(card).toHaveAttribute('data-tone', 'ok');
  } finally {
    await close();
  }
});

test('an older e-mail of a done ticket says so and links to it on the Board', async () => {
  const { page, close } = await launch({ qa: ['passed'] });
  try {
    await startFirstTicket(page);
    await dragCard(page, 1, 'inProgress');
    await dragCard(page, 1, 'inQa');
    await expect(page.getByTestId('card-1')).toHaveAttribute('data-status', 'codeReview', { timeout: 15_000 });
    await page.getByTestId('nav-dashboard').click();
    await expect(page.getByTestId('desk-primary')).toHaveText('Check code review');
    await page.getByTestId('desk-primary').click();
    await page.getByTestId('accept-review').click();
    await page.getByTestId('nav-dashboard').click();
    await page.getByTestId('inbox-message').filter({ hasText: 'Your first ticket: SD-214' }).getByRole('button').click();
    await expect(page.getByTestId('previous-directive')).toContainText('SD-214');
    await page.getByTestId('view-done-ticket').click();
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(page.getByTestId('ticket-panel')).toContainText('SD-214');
  } finally {
    await close();
  }
});

test('Local environment shows the dev server once a ticket exists, with a play or pause button and its tooltip', async () => {
  const { page, close } = await launch();
  try {
    await page.getByTestId('start-playing').click();
    // Before the first ticket the workspace has no code to run: no dev server row.
    await expect(page.getByTestId('env-docker')).toBeVisible();
    await expect(page.getByTestId('env-devServer')).toHaveCount(0);

    await page.getByTestId('next-assignment').click();
    await page.getByTestId('card-1').waitFor();
    await page.getByTestId('nav-dashboard').click();
    const row = page.getByTestId('env-devServer');
    await expect(row).toHaveAttribute('data-up', 'false');
    await expect(row).toContainText('Dev server');
    await expect(row).toContainText('Stopped');
    // Stopped: the row's icon and status in amber; running: in green.
    await expect(row).toHaveAttribute('data-tone', 'warn');
    const start = page.getByTestId('desk-start-server');
    await expect(start).toHaveAccessibleName('Start server');
    // The button is as tall as the row's two lines, and square.
    const size = await start.evaluate((button) => {
      const box = button.getBoundingClientRect();
      const lines = button.closest('li')!.querySelector('span.min-w-0')!.getBoundingClientRect();
      return { width: Math.round(box.width), height: Math.round(box.height), lines: Math.round(lines.height) };
    });
    expect(size.height).toBe(size.lines);
    expect(size.width).toBe(size.height);
    // Play in green, pause in amber.
    await expect(start).toHaveClass(/text-emerald-600/);
    await start.hover();
    await expect(row.getByRole('tooltip')).toBeVisible();
    await expect(row.getByRole('tooltip')).toHaveText('Start server');

    await start.click();
    await expect(row).toHaveAttribute('data-up', 'true');
    await expect(row).toContainText('Running');
    await expect(row).toHaveAttribute('data-tone', 'ok');
    const stop = page.getByTestId('desk-stop-server');
    await expect(stop).toHaveAccessibleName('Stop server');
    await expect(stop).toHaveClass(/text-amber-600/);
    await stop.click();
    await expect(row).toHaveAttribute('data-up', 'false');
    await expect(page.getByTestId('desk-start-server')).toBeVisible();
    await expect(row).toHaveAttribute('data-tone', 'warn');
    // Stopped is only a warning on its row: the section title stays green.
    await expect(page.getByTestId('environment-card')).toHaveAttribute('data-tone', 'ok');
  } finally {
    await close();
  }
});

test('the dev server row follows a server started or stopped in the VS Code terminal (polled every 5 s)', async () => {
  const { app, page, close } = await launch();
  try {
    await startFirstTicket(page);
    await page.getByTestId('nav-dashboard').click();
    const row = page.getByTestId('env-devServer');
    await expect(row).toHaveAttribute('data-up', 'false');
    // Started outside the app: the row catches up on its next check, without a click.
    await simulate(app, { devServerUp: true });
    await expect(row).toHaveAttribute('data-up', 'true', { timeout: 8000 });
    await expect(row).toContainText('Running');
    await expect(page.getByTestId('desk-stop-server')).toBeVisible();
    await simulate(app, { devServerUp: false });
    await expect(row).toHaveAttribute('data-up', 'false', { timeout: 8000 });
    await expect(page.getByTestId('desk-start-server')).toBeVisible();
  } finally {
    await close();
  }
});

test('starting or stopping the dev server shows an error toast when it fails, and the row keeps its state', async () => {
  const { app, page, close } = await launch({ devServerFails: true });
  try {
    await startFirstTicket(page);
    await page.getByTestId('nav-dashboard').click();
    const row = page.getByTestId('env-devServer');
    await page.getByTestId('desk-start-server').click();
    await expect(page.getByTestId('toast-error')).toContainText('npm run dev failed');
    await expect(row).toHaveAttribute('data-up', 'false');
    await expect(page.getByTestId('desk-start-server')).toBeEnabled();

    await simulate(app, { devServerUp: true });
    await expect(row).toHaveAttribute('data-up', 'true', { timeout: 8000 });
    await page.getByTestId('desk-stop-server').click();
    await expect(page.getByTestId('toast-error').last()).toContainText('pkill failed');
    await expect(row).toHaveAttribute('data-up', 'true');
  } finally {
    await close();
  }
});

test('the work desk shows the ticket download in progress, with its progress bar', async () => {
  const { page, close } = await launch({ unlockDelayMs: 3000 });
  try {
    await page.getByTestId('start-playing').click();
    await page.getByTestId('next-assignment').click();
    const task = page.getByTestId('assignment-card');
    await expect(task).toHaveAttribute('data-state', 'unlocking');
    await expect(task).toContainText('Downloading and setting up the ticket');
    await expect(task.getByRole('progressbar')).toBeVisible();
    await expect(page.getByTestId('next-assignment')).toHaveCount(0);
    // When the download ends, the app goes to the Board with the new ticket.
    await expect(page.getByTestId('card-1')).toBeVisible({ timeout: 10_000 });
  } finally {
    await close();
  }
});

test('the work desk asks to start Docker when it stops while the next assignment waits', async () => {
  const { app, page, close } = await launch();
  try {
    await page.getByTestId('start-playing').click();
    const task = page.getByTestId('assignment-card');
    await expect(task).toHaveAttribute('data-state', 'queued');
    await simulate(app, { docker: 'notRunning' });
    await expect(task).toHaveAttribute('data-state', 'dockerDown', { timeout: 5000 });
    await expect(task).toContainText('Start Docker Desktop to download your next ticket.');
    await expect(page.getByTestId('next-assignment')).toHaveCount(0);
    await expect(page.getByTestId('email-next')).toHaveCount(0);

    await page.getByTestId('desk-start-docker').click();
    await expect(task).toHaveAttribute('data-state', 'queued', { timeout: 5000 });
    await expect(page.getByTestId('next-assignment')).toBeEnabled();
  } finally {
    await close();
  }
});
