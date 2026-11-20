import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createNotesProject } from '../helpers/notes-project.ts';
import { dragCard, launch } from './fixtures.ts';

/**
 * The notes project: front-1 has no ticket.json (a fix ticket), front-2 is a build ticket that
 * touches both sides and names two skills. The fake runtime answers QA as the scenario says.
 */
test('a ticket says its type and its both-sides mark, words QA by type and shows its skills only when Done', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bd-ticket-type-'));
  const notes = await createNotesProject(dir);
  const { page, close } = await launch(
    { qa: ['passed', 'gate2', 'passed'] },
    { catalog: [{ id: 'notes', qaDir: notes.qaDir, starter: true }] },
  );
  const acceptReview = async (ticket: number) => {
    await page.getByTestId(`card-${ticket}`).click();
    await page.getByTestId('open-review').click();
    await page.getByTestId('accept-review').click();
    await expect(page.getByTestId(`card-${ticket}`)).toHaveAttribute('data-status', 'done');
  };
  try {
    await page.getByTestId('start-playing').click();

    // Before taking it: the first front ticket is a plain fix ticket.
    await page.getByTestId('next-assignment').click();
    const firstNext = page.getByTestId('next-assignment-front');
    await expect(firstNext.getByTestId('ticket-type')).toHaveAttribute('data-type', 'fix');
    await expect(firstNext.getByTestId('ticket-both-sides')).toHaveCount(0);
    await firstNext.click();

    const first = page.getByTestId('card-1');
    await expect(first.getByTestId('ticket-type')).toHaveText('Bug');
    await expect(first.getByTestId('ticket-both-sides')).toHaveCount(0);
    await dragCard(page, 1, 'inProgress');
    await dragCard(page, 1, 'inQa');
    await expect(first).toHaveAttribute('data-status', 'codeReview', { timeout: 15_000 });
    await acceptReview(1);
    // A Done ticket without skills shows nothing practiced.
    await first.click();
    await expect(page.getByTestId('ticket-panel')).toBeVisible();
    await expect(page.getByTestId('ticket-practiced')).toHaveCount(0);
    await page.getByTestId('close-panel').click();

    // The menu says what the next front ticket asks for before the player takes it.
    await page.getByTestId('nav-dashboard').click();
    await page.getByTestId('next-assignment').click();
    const secondNext = page.getByTestId('next-assignment-front');
    await expect(secondNext.getByTestId('ticket-type')).toHaveAttribute('data-type', 'build');
    await expect(secondNext.getByTestId('ticket-both-sides')).toHaveText('Front + back');
    await secondNext.click();

    const second = page.getByTestId('card-2');
    await expect(second.getByTestId('ticket-type')).toHaveText('Feature');
    await expect(second.getByTestId('ticket-both-sides')).toBeVisible();

    // A failed Gate 2 on a build ticket is not a bug still there, and the skills stay hidden.
    await dragCard(page, 2, 'inProgress');
    await dragCard(page, 2, 'inQa');
    await expect(second).toHaveAttribute('data-attempts', '1', { timeout: 15_000 });
    await expect(second).toHaveAttribute('data-status', 'inProgress');
    await second.click();
    const panel = page.getByTestId('ticket-panel');
    await expect(panel.locator('header').getByTestId('ticket-type')).toHaveAttribute('data-type', 'build');
    await panel.getByTestId('tab-qa').click();
    const comment = panel.getByTestId('qa-comment').first();
    await expect(comment).toHaveAttribute('data-kind', 'gate2Failed');
    await expect(comment.getByTestId('qa-comment-text')).toHaveText(
      'The ticket is not delivered yet. Part of what it asks for is still missing or does not work.',
    );
    await expect(panel.getByTestId('ticket-practiced')).toHaveCount(0);
    expect(await page.evaluate(() => window.bugDetective.snapshot().then((snapshot) => snapshot.practiced))).toEqual(
      {},
    );
    await panel.getByTestId('close-panel').click();

    // In Code Review the reference is introduced as a delivery, and the skills are still hidden.
    await dragCard(page, 2, 'inQa');
    await expect(second).toHaveAttribute('data-status', 'codeReview', { timeout: 15_000 });
    expect(await page.evaluate(() => window.bugDetective.snapshot().then((snapshot) => snapshot.practiced))).toEqual(
      {},
    );
    await second.click();
    await page.getByTestId('open-review').click();
    await expect(page.getByTestId('review-reference-intro')).toContainText('to deliver what the ticket asks.');
    await page.getByTestId('accept-review').click();
    await expect(second).toHaveAttribute('data-status', 'done');

    // Done: the ticket says what it trained, in the language of the app.
    await second.click();
    const practiced = page.getByTestId('ticket-practiced');
    await expect(practiced).toContainText('You practiced');
    await expect(practiced.getByRole('listitem')).toHaveText(['Building components', 'Routes and navigation']);
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});
