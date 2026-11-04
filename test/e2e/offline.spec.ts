import { expect, test } from '@playwright/test';
import { launch } from './fixtures.ts';

test('offline on the first download: a clear message, and "Try again" repeats the download', async () => {
  // A published project whose host is a closed port: every download fails on the network.
  const { page, close } = await launch(
    { environmentReady: false },
    { catalog: [{ id: 'supportdesk', repository: 'bug-detective-project/supportdesk', starter: true }], env: { BUGDETECTIVE_CONTENT_BASE_URL: 'http://127.0.0.1:1' } },
  );
  try {
    await expect(page.getByTestId('checklist-first-download')).toBeVisible();
    await page.getByTestId('start-playing').click();
    await page.getByTestId('install-environment').click();
    const modal = page.getByTestId('install-modal');
    await expect(modal.getByTestId('install-modal-error')).toContainText('No internet connection', { timeout: 60_000 });
    await expect(modal.getByTestId('install-modal-retry')).toBeVisible();

    await modal.getByTestId('install-modal-retry').click();
    await expect(modal.getByTestId('install-modal-status')).toBeVisible();
    await expect(modal.getByTestId('install-modal-error')).toContainText('No internet connection', { timeout: 60_000 });
  } finally {
    await close();
  }
});
