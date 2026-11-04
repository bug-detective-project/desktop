import { expect, test } from '@playwright/test';
import { launch, simulate, startFirstTicket } from './fixtures.ts';

test('a lost workspace shows the notice on the Dashboard, and "Recreate the code" brings it back', async () => {
  const { app, page, close } = await launch();
  try {
    await startFirstTicket(page);
    await page.getByTestId('nav-dashboard').click();
    await expect(page.getByTestId('workspace-lost')).toHaveCount(0);

    await simulate(app, { workspaceLost: true });
    await page.evaluate(() => window.bugDetective.refreshEnvironment());
    await expect(page.getByTestId('workspace-lost')).toBeVisible();
    await expect(page.getByTestId('open-vscode')).toHaveCount(0);

    await page.getByTestId('rebuild-workspace').click();
    await expect(page.getByTestId('workspace-lost')).toHaveCount(0, { timeout: 30_000 });
    await page.getByTestId('nav-board').click();
    await expect(page.getByTestId('card-1')).toHaveAttribute('data-status', 'todo');
  } finally {
    await close();
  }
});

test('"Restore a backup instead" opens Settings', async () => {
  const { app, page, close } = await launch();
  try {
    await startFirstTicket(page);
    await page.getByTestId('nav-dashboard').click();
    await simulate(app, { workspaceLost: true });
    await page.evaluate(() => window.bugDetective.refreshEnvironment());
    await page.getByTestId('restore-backup-instead').click();
    await expect(page.getByTestId('settings-pane-backup').or(page.getByTestId('settings'))).toBeVisible();
  } finally {
    await close();
  }
});
