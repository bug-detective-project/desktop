import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

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
