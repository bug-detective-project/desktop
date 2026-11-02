import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { launch } from './fixtures.ts';

async function resize(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height]);
  await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([width, height]);
}

test('downloading the environment opens a large modal with the log that only closes with "Close" when it ends', async () => {
  const { app, page, close } = await launch({ environmentReady: false, installDelayMs: 2500 });
  try {
    await page.getByTestId('start-playing').click();
    await page.getByTestId('install-environment').click();
    const modal = page.getByTestId('install-modal');
    await expect(modal).toBeVisible();
    await expect(modal.getByRole('heading')).toHaveText('Downloading the game environment');
    // While it runs: the log is live and the modal cannot be closed.
    await expect(modal.getByTestId('install-modal-status')).toContainText('Downloading and installing');
    await expect(modal.getByTestId('log-view')).toContainText('» docker build bugdetective-workspace (fake)');
    await expect(modal.getByTestId('install-modal-close')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(modal).toBeVisible();
    // Large: most of the window.
    const box = (await modal.getByRole('document').boundingBox())!;
    const [width, height] = await page.evaluate(() => [window.innerWidth, window.innerHeight]);
    expect(box.width).toBeGreaterThan(width * 0.6);
    expect(box.height).toBeGreaterThan(height * 0.6);

    // Done: it stays open with the whole log, "Copy log" and "Close".
    await expect(modal.getByTestId('install-modal-status')).toHaveText('Everything is ready.', { timeout: 10_000 });
    await expect(modal.getByTestId('log-view')).toContainText('» docker build bugdetective-qa (fake)');
    await modal.getByTestId('install-modal-copy').click();
    await expect.poll(() => app.evaluate(({ clipboard }) => clipboard.readText())).toContain('» docker build bugdetective-qa (fake)');
    // The page may write to the clipboard, never read it.
    expect(await page.evaluate(() => navigator.clipboard.readText().then(() => 'read', () => 'denied'))).toBe('denied');
    await page.keyboard.press('Escape');
    await expect(modal).toBeVisible();
    // The work desk no longer shows the log.
    await expect(page.getByTestId('assignment-card').getByTestId('log-view')).toHaveCount(0);

    // At the smallest window the app supports, the buttons stay on screen.
    await resize(app, page, 1280, 640);
    await expect(modal.getByTestId('install-modal-close')).toBeInViewport({ ratio: 1 });
    await modal.getByTestId('install-modal-close').click();
    await expect(modal).toHaveCount(0);
    await expect(page.getByTestId('assignment-card')).toHaveAttribute('data-state', 'queued');
  } finally {
    await close();
  }
});

test('a failed download keeps the modal open with the error and the log until "Close", in Portuguese too', async () => {
  const { page, close } = await launch({ environmentReady: false, installFails: 'docker build failed: no space left on device' });
  try {
    await page.getByTestId('start-playing').click();
    await page.evaluate(() => window.bugDetective.updateSettings({ language: 'pt' }));
    await page.getByTestId('install-environment').click();
    const modal = page.getByTestId('install-modal');
    await expect(modal.getByTestId('install-modal-error')).toContainText('no space left on device');
    await expect(modal.getByTestId('log-view')).toContainText('» docker build bugdetective-workspace (fake)');
    await expect(modal.getByRole('heading')).toHaveText('Baixando o ambiente do jogo');
    await expect(modal.getByTestId('install-modal-close')).toHaveText('Fechar');
    await expect(modal.getByTestId('install-modal-copy')).toHaveText('Copiar log');
    await modal.getByTestId('install-modal-close').click();
    await expect(modal).toHaveCount(0);
    // Nothing was installed: the work desk still offers the download.
    await expect(page.getByTestId('environment-panel')).toHaveAttribute('data-state', 'download');
  } finally {
    await close();
  }
});
