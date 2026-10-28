import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { dragCard, launch, startFirstTicket } from './fixtures.ts';

test('the ticket panel shows the ticket, QA comments, history and the senior-dev conversation', async () => {
  const { page, close } = await launch({ qa: ['gate2'] });
  try {
    await startFirstTicket(page);
    await page.getByTestId('card-1').click();
    const panel = page.getByTestId('ticket-panel');
    await expect(panel.getByTestId('ticket-title')).toContainText('SD-214');
    await expect(panel.getByTestId('ticket-markdown')).toContainText('Steps to reproduce');
    await expect(panel.getByTestId('open-vscode')).toBeEnabled();
    await expect(panel.getByTestId('open-browser')).toContainText(':5173');
    // The workspace is on player/ticket-1, but git branch names are never shown.
    await expect(panel).not.toContainText('player/');

    // Hints only from In Progress.
    await panel.getByTestId('tab-senior').click();
    await expect(panel.getByTestId('conversation')).toContainText('Move the card to In Progress');
    await expect(panel.getByTestId('ask-hint')).toHaveCount(0);
    await panel.getByTestId('close-panel').click();
    await dragCard(page, 1, 'inProgress');
    await page.getByTestId('card-1').click();
    await panel.getByTestId('tab-senior').click();

    for (let hint = 1; hint <= 3; hint += 1) {
      await panel.getByTestId('ask-hint').click();
      await expect(panel.getByTestId('chat-hint')).toHaveCount(hint);
      await expect(panel.getByTestId('hints-used')).toContainText(`${hint} of 3`);
    }
    await expect(panel.getByTestId('chat-hint').first()).toContainText('DevTools');
    await expect(panel.getByTestId('ask-hint')).toHaveCount(0);
    await panel.getByTestId('reveal-solution').click();
    await expect(panel.getByTestId('solution')).toContainText('Root cause');
    await expect(panel.getByTestId('solution-diff')).toContainText('TicketDetails.tsx');
    await expect(panel.getByTestId('reveal-solution')).toHaveCount(0);

    // QA failure: comment names the gate, lists failing tests with errors.
    await panel.getByTestId('close-panel').click();
    await dragCard(page, 1, 'inQa');
    // Wait for the attempt itself: the card can still be in In Progress before the move lands.
    await expect(page.getByTestId('card-1')).toHaveAttribute('data-attempts', '1', { timeout: 15_000 });
    await expect(page.getByTestId('card-1')).toHaveAttribute('data-status', 'inProgress');
    await page.getByTestId('card-1').click();
    await panel.getByTestId('tab-qa').click();
    const comment = panel.getByTestId('qa-comment').first();
    await expect(comment).toHaveAttribute('data-kind', 'gate2Failed');
    await expect(comment.locator('header')).toContainText('Test failed');
    await expect(comment).toContainText('The reported bug is still unresolved');
    await expect(comment).not.toContainText('Gate');
    await expect(comment.getByTestId('qa-failing-test')).toContainText('Next shows the next ticket');
    await expect(comment.getByTestId('qa-failing-test')).toContainText('Expected "4", received "3"');

    // History: attempts and the append-only activity log.
    await panel.getByTestId('tab-history').click();
    await expect(panel.getByTestId('attempt')).toHaveCount(1);
    await expect(panel.getByTestId('attempt')).toContainText('failed');
    await expect(panel.getByTestId('attempt')).not.toContainText('Gate');
    await expect(panel.getByTestId('activity-entry')).toHaveCount(4);
    await expect(panel.getByTestId('activity')).toContainText('In QA → In Progress');
    await expect(panel).toContainText('Hints used: 3 of 3');
    await expect(panel).toContainText('Solution revealed');
  } finally {
    await close();
  }
});

test('the game UI and the game texts switch to Portuguese, and state survives a restart', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'João Silva e2e-'));
  try {
    const first = await launch({}, { userData });
    await startFirstTicket(first.page);
    await first.page.getByTestId('nav-settings').click();
    await first.page.getByTestId('language-pt').click();
    await expect(first.page.getByTestId('nav-board')).toHaveText('Quadro');
    await first.close();

    const second = await launch({}, { userData });
    try {
      await second.page.getByTestId('nav-board').click();
      await second.page.getByTestId('card-1').click();
      await expect(second.page.getByTestId('ticket-markdown')).toContainText('Passos para reproduzir');
      await expect(second.page.getByTestId('ticket-title')).toContainText('Anterior e Próximo');
      await second.page.getByTestId('close-panel').click();
      await second.page.getByTestId('nav-dashboard').click();
      await expect(second.page.getByTestId('inbox')).toContainText('Seu primeiro ticket: SD-214');
    } finally {
      await second.close();
    }
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test('the QA tab groups the errors of each run in a dropdown, the latest run open', async () => {
  const { page, close } = await launch({ qa: ['gate2', 'gate1', 'passed'], qaDelayMs: 300 });
  try {
    await startFirstTicket(page);
    await dragCard(page, 1, 'inProgress');
    await dragCard(page, 1, 'inQa');
    await expect(page.getByTestId('card-1')).toHaveAttribute('data-attempts', '1', { timeout: 15_000 });
    await dragCard(page, 1, 'inQa');
    await expect(page.getByTestId('card-1')).toHaveAttribute('data-attempts', '2', { timeout: 15_000 });
    await page.getByTestId('card-1').click();
    const panel = page.getByTestId('ticket-panel');
    await panel.getByTestId('tab-qa').click();

    const [latest, earlier] = [panel.getByTestId('qa-comment').nth(0), panel.getByTestId('qa-comment').nth(1)];
    await expect(latest).toHaveAttribute('data-kind', 'gate1Failed');
    await expect(latest.getByTestId('qa-errors')).toHaveJSProperty('open', true);
    await expect(latest.getByTestId('qa-errors').locator('summary')).toHaveText('1 error in this run');
    await expect(latest.getByTestId('qa-failing-test')).toContainText('expected 15 rows, got 0');

    await expect(latest.locator('header')).toContainText('Test failed');
    await expect(earlier).toHaveAttribute('data-kind', 'gate2Failed');
    await expect(earlier.getByTestId('qa-errors')).toHaveJSProperty('open', false);
    await expect(earlier.getByTestId('qa-failing-test')).toBeHidden();
    await earlier.getByTestId('qa-errors').locator('summary').click();
    await expect(earlier.getByTestId('qa-failing-test')).toContainText('Expected "4", received "3"');

    // A passing run: a green "Tests passed" badge and no error dropdown.
    await panel.getByTestId('close-panel').click();
    await dragCard(page, 1, 'inQa');
    await expect(page.getByTestId('card-1')).toHaveAttribute('data-status', 'codeReview', { timeout: 15_000 });
    await page.getByTestId('card-1').click();
    await panel.getByTestId('tab-qa').click();
    const passed = panel.getByTestId('qa-comment').first();
    await expect(passed).toHaveAttribute('data-kind', 'passed');
    await expect(passed.locator('header')).toContainText('Tests passed');
    await expect(passed.getByTestId('qa-errors')).toHaveCount(0);
  } finally {
    await close();
  }
});
