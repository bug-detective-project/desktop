import { expect, test } from '@playwright/test';
import { dragCard, launch, startFirstTicket } from './fixtures.ts';

test('the computer going to sleep during QA interrupts the run: no attempt counted, the card goes back to In Progress', async () => {
  const { app, page, close } = await launch({ qa: ['passed'], qaDelayMs: 8000 });
  try {
    await startFirstTicket(page);
    await dragCard(page, 1, 'inProgress');
    await dragCard(page, 1, 'inQa');
    await expect(page.getByTestId('card-1')).toHaveAttribute('data-status', 'inQa');

    await app.evaluate(({ powerMonitor }) => {
      (powerMonitor as unknown as { emit(event: string): void }).emit('suspend');
    });
    await expect(page.getByTestId('card-1')).toHaveAttribute('data-status', 'inProgress', { timeout: 15_000 });
    await page.getByTestId('card-1').click();
    await page.getByTestId('tab-qa').click();
    await expect(page.getByTestId('qa-comment').first()).toHaveAttribute('data-kind', 'interrupted');
    await expect(page.getByTestId('card-1')).toHaveAttribute('data-attempts', '0');
  } finally {
    await close();
  }
});
