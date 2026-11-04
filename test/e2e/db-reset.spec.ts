import { expect, test } from '@playwright/test';
import { launch, simulate, startFirstTicket } from './fixtures.ts';

test('a failed database reset shows the app data row with "Try again", which clears it once the reset works', async () => {
  const { app, page, close } = await launch({ dbResetFails: true });
  try {
    await startFirstTicket(page);
    await page.getByTestId('nav-dashboard').click();
    const row = page.getByTestId('env-database');
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-tone', 'danger');
    await expect(page.getByTestId('environment-card')).toHaveAttribute('data-tone', 'danger');

    // Still failing: the row stays and the error shows.
    await page.getByTestId('retry-database-reset').click();
    await expect(page.getByText('The app data could not be reset. Check the Docker log and try again.')).toBeVisible();
    await expect(row).toBeVisible();

    await simulate(app, { dbResetFails: false });
    await page.getByTestId('retry-database-reset').click();
    await expect(row).toHaveCount(0);
  } finally {
    await close();
  }
});
