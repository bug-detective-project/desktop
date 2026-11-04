import { expect, test } from '@playwright/test';
import { launch } from './fixtures.ts';

test('a render error shows the crash screen instead of a blank window, and Reload brings the app back', async () => {
  const { page, close } = await launch();
  try {
    await expect(page.getByTestId('checklist').or(page.getByTestId('dashboard')).first()).toBeVisible();
    await page.evaluate(() => window.dispatchEvent(new Event('bugdetective:e2e-throw')));
    await expect(page.getByTestId('error-boundary')).toBeVisible();
    await expect(page.getByTestId('error-boundary-message')).toContainText('a render error on purpose');
    await page.getByTestId('reload-app').click();
    await expect(page.getByTestId('checklist').or(page.getByTestId('dashboard')).first()).toBeVisible();
    await expect(page.getByTestId('error-boundary')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('a renderer that dies is reloaded on its own', async () => {
  const { app, page, close } = await launch();
  try {
    await expect(page.getByTestId('checklist').or(page.getByTestId('dashboard')).first()).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer();
    });
    const reloaded = await app.firstWindow();
    await expect(reloaded.getByTestId('checklist').or(reloaded.getByTestId('dashboard')).first()).toBeVisible({ timeout: 30_000 });
  } finally {
    await close();
  }
});
