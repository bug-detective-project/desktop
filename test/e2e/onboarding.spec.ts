import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { launch, startFirstTicket } from './fixtures.ts';

/** The e2e tests keep the onboarding closed unless they ask for it. */
const SHOW = { BUGDETECTIVE_E2E_SHOW_ONBOARDING: 'true' };

const STEPS = [
  'currentTask',
  'environment',
  'client',
  'inbox',
  'message',
  'board',
  'columns',
  'card',
  'qa',
  'ticketOpen',
  'ticketHeader',
  'ticketActions',
  'ticketTab',
  'qaTab',
  'historyTab',
  'seniorTab',
  'review',
  'settings',
  'replay',
];
/** The steps on the example ticket panel, and the tab each one shows. */
const PANEL_TABS: Record<string, string> = {
  ticketOpen: 'ticket',
  ticketHeader: 'ticket',
  ticketActions: 'ticket',
  ticketTab: 'ticket',
  qaTab: 'qa',
  historyTab: 'history',
  seniorTab: 'senior',
};

const overlay = (page: Page) => page.getByTestId('onboarding');

/** The highlight sits around the element, 6px apart (polled: it glides from the previous step). */
async function expectHighlighted(page: Page, testId: string) {
  const target = (await page.getByTestId(testId).boundingBox())!;
  await expect
    .poll(async () => {
      const highlight = (await page.getByTestId('onboarding-highlight').boundingBox())!;
      return Math.max(Math.abs(highlight.x - (target.x - 6)), Math.abs(highlight.width - (target.width + 12)));
    })
    .toBeLessThanOrEqual(1);
}

/** The balloon stays inside the window. */
async function expectBalloonInWindow(page: Page) {
  const box = await page.getByTestId('onboarding-step').boundingBox();
  const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
}

test('the first time, Rafaela walks through the Dashboard and the Board, and it cannot be skipped', async () => {
  const { app, page, close } = await launch({}, { env: SHOW });
  try {
    // The smallest layout, a 14-inch laptop: every balloon fits.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 640));
    await page.getByTestId('start-playing').click();

    const welcome = page.getByTestId('onboarding-welcome');
    await expect(welcome).toContainText('Rafaela Nunes');
    await expect(welcome).toContainText('Engineering manager');
    await expect(page.getByTestId('onboarding-skip')).toHaveCount(0);
    await expect(page.getByTestId('onboarding-close')).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(welcome).toBeVisible();
    await page.getByTestId('onboarding-start').click();

    for (const [index, id] of STEPS.entries()) {
      await expect(overlay(page)).toHaveAttribute('data-step', id);
      await expect(page.getByTestId('onboarding-progress')).toHaveText(`Step ${index + 1} of ${STEPS.length}`);
      await expect(page.getByTestId('onboarding-close')).toHaveCount(0);
      await expect(page.getByTestId('onboarding-back')).toHaveCount(index === 0 ? 0 : 1);
      await expectBalloonInWindow(page);
      const view = index < STEPS.indexOf('columns') ? 'dashboard' : 'board';
      await expect(page.getByTestId(`nav-${view}`)).toHaveAttribute('aria-current', 'page');

      if (id === 'columns') {
        // Back returns to the Dashboard step, the arrow comes back to the Board.
        await page.getByTestId('onboarding-back').click();
        await expect(overlay(page)).toHaveAttribute('data-step', 'board');
        await expect(page.getByTestId('nav-dashboard')).toHaveAttribute('aria-current', 'page');
        await page.keyboard.press('ArrowRight');
        await expect(overlay(page)).toHaveAttribute('data-step', 'columns');
        await expect(page.getByTestId('onboarding-illustration-flow')).toBeVisible();
      }
      if (id === 'card') await expect(page.getByTestId('onboarding-illustration-card')).toContainText('SD-000');
      const demo = page.getByTestId('onboarding-ticket-demo');
      if (PANEL_TABS[id]) {
        // The example panel, never a real ticket, on the tab this step explains.
        await expect(demo).toContainText('SD-000');
        await expect(demo.getByTestId(`tab-${PANEL_TABS[id]}`)).toHaveAttribute('aria-selected', 'true');
        await expect(page.getByTestId('ticket-panel')).toHaveCount(0);
      } else {
        await expect(demo).toHaveCount(0);
      }
      if (id === 'ticketActions') await expect(demo).toContainText('Open in VS Code');
      if (id === 'qaTab') await expect(demo.getByTestId('qa-comment')).toContainText('Expected 1 result, received 0');
      if (id === 'seniorTab') await expect(demo).toContainText('Ask for a hint');
      if (id === 'board') await expectHighlighted(page, 'nav-board');
      if (id === 'settings') {
        await expectHighlighted(page, 'nav-settings');
        // The highlighted button is shown, not used: Settings does not open.
        const gear = await page.getByTestId('nav-settings').boundingBox();
        await page.mouse.click(gear!.x + gear!.width / 2, gear!.y + gear!.height / 2);
        await expect(page.getByTestId('nav-board')).toHaveAttribute('aria-current', 'page');
        await expect(overlay(page)).toHaveAttribute('data-step', 'settings');
      }
      if (id === 'replay') await expectHighlighted(page, 'onboarding-replay');
      // Neither does Escape close it the first time.
      await page.keyboard.press('Escape');
      await page.getByTestId('onboarding-next').click();
    }

    const closing = page.getByTestId('onboarding-closing');
    await expect(closing).toContainText('Get next assignment');
    await page.getByTestId('onboarding-finish').click();
    await expect(overlay(page)).toHaveCount(0);
    // The example never entered the game.
    const tickets = await page.evaluate(async () => (await (window as unknown as { bugDetective: { snapshot(): Promise<{ state: { tickets: unknown[] } }> } }).bugDetective.snapshot()).state.tickets.length);
    expect(tickets).toBe(0);
    await expect(page.getByTestId('nav-dashboard')).toHaveAttribute('aria-current', 'page');

    // Finished: it does not open again, not even after a reload.
    await page.reload();
    await page.getByTestId('start-playing').click();
    await expect(page.getByTestId('dashboard')).toBeVisible();
    await expect(overlay(page)).toHaveCount(0);
  } finally {
    await close();
  }
});

test('an onboarding left halfway starts over after a restart', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'bd-onboarding-'));
  try {
    const first = await launch({}, { userData, env: SHOW });
    try {
      await first.page.getByTestId('start-playing').click();
      await first.page.getByTestId('onboarding-start').click();
      await first.page.getByTestId('onboarding-next').click();
      await first.page.getByTestId('onboarding-next').click();
      await expect(overlay(first.page)).toHaveAttribute('data-step', 'client');
    } finally {
      await first.close();
    }
    const second = await launch({}, { userData, env: SHOW });
    try {
      await second.page.getByTestId('start-playing').click();
      await expect(second.page.getByTestId('onboarding-welcome')).toBeVisible();
    } finally {
      await second.close();
    }
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test('the "?" button replays the onboarding from any screen, and a replay closes anytime', async () => {
  const { page, close } = await launch();
  try {
    await startFirstTicket(page);
    await expect(overlay(page)).toHaveCount(0);

    const replay = page.getByTestId('onboarding-replay');
    await replay.hover();
    await expect(replay.locator('xpath=..').getByRole('tooltip')).toBeVisible();
    await expect(replay.locator('xpath=..').getByRole('tooltip')).toContainText('Replay the onboarding');

    // From the Board: it goes to the Dashboard and starts with Rafaela's welcome; Escape closes it.
    await replay.click();
    await expect(page.getByTestId('onboarding-welcome')).toBeVisible();
    await expect(page.getByTestId('nav-dashboard')).toHaveAttribute('aria-current', 'page');
    await page.keyboard.press('Escape');
    await expect(overlay(page)).toHaveCount(0);

    // From Settings, closed with the X in the middle of a step.
    await page.getByTestId('nav-settings').click();
    await replay.click();
    await page.getByTestId('onboarding-start').click();
    await page.getByTestId('onboarding-next').click();
    await expect(overlay(page)).toHaveAttribute('data-step', 'environment');
    await page.getByTestId('onboarding-close').click();
    await expect(overlay(page)).toHaveCount(0);
    await expect(page.getByTestId('dashboard')).toBeVisible();
  } finally {
    await close();
  }
});

test('with BUGDETECTIVE_DEV_SKIP_ONBOARDING_BUTTON, the onboarding can be skipped', async () => {
  const { page, close } = await launch({}, { env: { ...SHOW, BUGDETECTIVE_DEV_SKIP_ONBOARDING_BUTTON: 'true' } });
  try {
    await page.getByTestId('start-playing').click();
    await page.getByTestId('onboarding-start').click();
    await page.getByTestId('onboarding-skip').click();
    await expect(overlay(page)).toHaveCount(0);
    await page.reload();
    await page.getByTestId('start-playing').click();
    await expect(page.getByTestId('dashboard')).toBeVisible();
    await expect(overlay(page)).toHaveCount(0);
  } finally {
    await close();
  }
});
