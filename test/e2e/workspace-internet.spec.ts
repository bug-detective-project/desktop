import { expect, test } from '@playwright/test';
import { launch, startFirstTicket } from './fixtures.ts';

test('opening the workspace to the internet asks first, shows on the Dashboard, and closes on the next ticket', async () => {
  const { page, close } = await launch({ qa: ['passed'], qaDelayMs: 200 });
  try {
    await page.getByTestId('start-playing').click();
    await expect(page.getByTestId('env-internet')).toHaveCount(0);
    await page.getByTestId('next-assignment').click();
    await page.getByTestId('next-assignment-front').click();
    await page.getByTestId('board').waitFor();
    await page.getByTestId('nav-dashboard').click();
    const row = page.getByTestId('env-internet');
    await expect(row).toHaveAttribute('data-on', 'false');
    await expect(row).toContainText('Off');

    // Cancel changes nothing.
    await page.getByTestId('workspace-internet-toggle').click();
    await expect(page.getByTestId('workspace-internet-warning')).toContainText('your computer (host.docker.internal) and your local network');
    await page.getByTestId('workspace-internet-cancel').click();
    await expect(row).toHaveAttribute('data-on', 'false');

    await page.getByTestId('workspace-internet-toggle').click();
    await page.getByTestId('workspace-internet-confirm').click();
    await expect(row).toHaveAttribute('data-on', 'true');
    await expect(row).toContainText('On until the next ticket');
    await expect(row).toHaveAttribute('data-tone', 'warn');
    await expect(page.getByTestId('environment-card')).toHaveAttribute('data-tone', 'warn');

    // Off again by hand, with no question.
    await page.getByTestId('workspace-internet-toggle').click();
    await expect(row).toHaveAttribute('data-on', 'false');
    await expect(page.getByTestId('environment-card')).toHaveAttribute('data-tone', 'ok');

    // On, then the game closes it with the next ticket.
    await page.getByTestId('workspace-internet-toggle').click();
    await page.getByTestId('workspace-internet-confirm').click();
    await expect(row).toHaveAttribute('data-on', 'true');
    await page.evaluate(async () => {
      await window.bugDetective.move(1, 'inProgress');
      await window.bugDetective.move(1, 'inQa');
    });
    await expect.poll(async () => page.evaluate(async () => (await window.bugDetective.snapshot()).state.tickets[0].status), { timeout: 15_000 }).toBe('codeReview');
    await page.evaluate(async () => {
      await window.bugDetective.acceptReview(1);
      await window.bugDetective.nextAssignment('front');
    });
    await expect.poll(async () => page.evaluate(async () => (await window.bugDetective.snapshot()).workspaceInternet)).toBe(false);
  } finally {
    await close();
  }
});

test('the warning is in Portuguese too', async () => {
  const { page, close } = await launch();
  try {
    await startFirstTicket(page);
    await page.evaluate(() => window.bugDetective.updateSettings({ language: 'pt' }));
    await page.getByTestId('nav-dashboard').click();
    await expect(page.getByTestId('env-internet')).toContainText('Internet do workspace');
    await page.getByTestId('workspace-internet-toggle').click();
    await expect(page.getByTestId('workspace-internet-warning')).toContainText('o seu computador (host.docker.internal) e a sua rede local');
  } finally {
    await close();
  }
});
