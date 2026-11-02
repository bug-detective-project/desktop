import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { dragCard, launch, startFirstTicket, takeNextTicket } from './fixtures.ts';

/** Plays an unlocked ticket to Done with the fake QA passing. */
async function finish(page: Page, ticket: number) {
  await dragCard(page, ticket, 'inProgress');
  await dragCard(page, ticket, 'inQa');
  await expect(page.getByTestId(`card-${ticket}`)).toHaveAttribute('data-status', 'codeReview', { timeout: 15_000 });
  await page.getByTestId('nav-dashboard').click();
  await page.getByTestId('desk-primary').click();
  await page.getByTestId('accept-review').click();
  await expect(page.getByTestId(`card-${ticket}`)).toHaveAttribute('data-status', 'done');
}

test('Projects shows up once a track is done, with each project, its difficulty and progress', async () => {
  test.setTimeout(120_000);
  const { page, close } = await launch({ qa: ['passed'] });
  try {
    await startFirstTicket(page);
    await expect(page.getByTestId('nav-projects')).toHaveCount(0);
    await finish(page, 1);
    for (const ticket of [2, 3, 4]) {
      await page.getByTestId('nav-dashboard').click();
      await takeNextTicket(page, 'front');
      await expect(page.getByTestId(`card-${ticket}`)).toHaveAttribute('data-status', 'todo');
      await finish(page, ticket);
    }
    // The front track is done, so the project is done: Projects appears and stays.
    await expect(page.getByTestId('nav-projects')).toBeVisible();
    await page.getByTestId('nav-projects').click();
    const card = page.getByTestId('project-supportdesk');
    await expect(card).toContainText('SupportDesk');
    await expect(card.getByTestId('project-active')).toHaveText('In progress');
    await expect(card.getByTestId('project-difficulty')).toHaveText('Beginner');
    await expect(card.getByTestId('project-tickets')).toHaveText('Front 4/4 · Back 0/4');
    // The active project has no switch button.
    await expect(card.getByRole('button')).toHaveCount(0);
  } finally {
    await close();
  }
});
