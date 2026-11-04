import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Closes the VS Code windows left attached to the workspace container. Once such a window gives up
 * on a container that is gone ("Container server terminated early. Not reconnecting."), opening
 * the same folder only focuses it: the command returns 0, no window opens and nothing attaches.
 */
export async function closeAttachedWindows(): Promise<void> {
  if (process.platform !== 'win32') return;
  const script = join(import.meta.dirname, 'close-attached-windows.ps1');
  const closed = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Match', '[Container bugdetective-workspace'], { encoding: 'utf8' }).trim();
  if (closed !== '0') {
    console.log(`Asked ${closed} attached VS Code window(s) to close`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
}

/**
 * Walks through Rafaela's onboarding the way a player does the first time: Start, Next on every
 * step, Finish. The real app shows it after "Start playing" (the e2e tests hide it unless asked),
 * and it blocks every click until it is finished.
 */
export async function finishOnboarding(page: Page): Promise<void> {
  const welcome = page.getByTestId('onboarding-welcome');
  await expect(welcome).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('onboarding-start').click();
  const next = page.getByTestId('onboarding-next');
  const finish = page.getByTestId('onboarding-finish');
  // Each step shows Next; the closing message shows Finish instead.
  for (let step = 0; step < 50; step += 1) {
    if (await finish.isVisible()) {
      break;
    }
    await next.click();
  }
  await finish.click();
  await expect(page.getByTestId('onboarding')).toHaveCount(0);
}
