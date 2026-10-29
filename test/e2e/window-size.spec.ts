import { expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { launch, startFirstTicket } from './fixtures.ts';

/** Resizes the window's content area; the window minimum would otherwise stop below 960 x 540. */
async function resize(app: ElectronApplication, page: Page, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h), [width, height]);
  await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([width, height]);
}

/** How far the page itself scrolls past the window, horizontally and vertically. */
const pageOverflow = (page: Page) =>
  page.evaluate(() => {
    const root = document.documentElement;
    return { x: root.scrollWidth - root.clientWidth, y: root.scrollHeight - root.clientHeight };
  });

test('every screen fits a 14-inch laptop and scrolls instead of squeezing in a smaller window', async () => {
  const { app, page, close } = await launch({ qa: ['passed'] });
  try {
    // 14 inches: 1920 x 1080 at 150%, minus the taskbar and the title bar.
    await resize(app, page, 1280, 640);
    await page.getByTestId('checklist').waitFor();
    expect(await pageOverflow(page)).toEqual({ x: 0, y: 0 });
    await startFirstTicket(page);

    const screens: [string, () => Promise<void>][] = [
      ['board', () => page.getByTestId('nav-board').click()],
      ['dashboard', () => page.getByTestId('nav-dashboard').click()],
      ['settings', () => page.getByTestId('nav-settings').click()],
    ];
    for (const [testId, open] of screens) {
      await resize(app, page, 1280, 640);
      await open();
      await page.getByTestId(testId).waitFor();
      expect(await pageOverflow(page), `${testId} at 1280 x 640`).toEqual({ x: 0, y: 0 });
      const width = (await page.getByTestId(testId).boundingBox())!.width;

      // Smaller: the page scrolls and the screen keeps its 14-inch layout.
      await resize(app, page, 1000, 560);
      const overflow = await pageOverflow(page);
      expect(overflow.x, `${testId} at 1000 x 560`).toBeGreaterThanOrEqual(280);
      expect(overflow.y, `${testId} at 1000 x 560`).toBeGreaterThanOrEqual(80);
      expect((await page.getByTestId(testId).boundingBox())!.width, `${testId} keeps its width`).toBe(width);
    }

    // The dashboard's three panes keep their width; the desk and the inbox scroll on their own.
    await page.getByTestId('nav-dashboard').click();
    const desk = await page.getByTestId('dashboard').locator('aside').first().boundingBox();
    expect(desk!.width).toBe(320);
  } finally {
    await close();
  }
});
