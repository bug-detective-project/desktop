import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { dragCard, expectFlagsLoaded, launch, startFirstTicket } from './fixtures.ts';

test('settings: preferences, developer tools, backup and about tabs', async () => {
  const { app, page, close } = await launch();
  const saves = await mkdtemp(join(tmpdir(), 'Meus saves '));
  try {
    await startFirstTicket(page);
    // Settings is a gear button after the language menu, not a navigation tab.
    await expect(page.getByRole('navigation').getByTestId('nav-settings')).toHaveCount(0);
    await expect(page.getByTestId('nav-settings')).toHaveText('');
    await expect(page.getByTestId('nav-settings')).toHaveAccessibleName('Settings');
    const [language, gear] = await Promise.all([page.getByTestId('language-menu').boundingBox(), page.getByTestId('nav-settings').boundingBox()]);
    expect(gear!.x).toBeGreaterThan(language!.x);
    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('nav-settings')).toHaveAttribute('aria-current', 'page');
    const settings = page.getByTestId('settings');

    // Preferences: language and theme apply at once. Each language option shows its flag.
    await expectFlagsLoaded(page.getByTestId('settings-pane-preferences'), ['en', 'pt']);
    await page.getByTestId('language-pt').click();
    await expect(settings.getByRole('heading', { level: 1 })).toHaveText('Configurações');
    await page.getByTestId('language-en').click();
    await expect(settings.getByRole('heading', { level: 1 })).toHaveText('Settings');
    await page.getByTestId('theme-dark').click();
    await expect(page.locator('html')).toHaveClass(/dark/);
    await page.getByTestId('theme-light').click();
    await expect(page.locator('html')).not.toHaveClass(/dark/);

    // QA limit: minutes, out of range explained and never saved.
    const timeout = page.getByTestId('qa-timeout');
    await expect(timeout).toHaveValue('3');
    // The field's arrows step whole minutes.
    await timeout.press('ArrowUp');
    await expect(timeout).toHaveValue('4');
    await timeout.press('ArrowDown');
    await timeout.press('ArrowDown');
    await expect(timeout).toHaveValue('2');
    await timeout.fill('0.5');
    await timeout.blur();
    await expect(page.getByTestId('qa-timeout-error')).toHaveText('Enter between 1 and 30 minutes.');
    await timeout.fill('2.5');
    await timeout.press('Enter');
    await expect(timeout).toHaveValue('2.5');
    await expect(page.getByTestId('qa-timeout-error')).toHaveCount(0);
    await page.getByRole('button', { name: '1 minute more' }).click();
    await expect(timeout).toHaveValue('3.5');
    await page.getByRole('button', { name: '1 minute less' }).click();
    await expect(timeout).toHaveValue('2.5');
    await page.getByRole('button', { name: '1 minute more' }).click();

    // Developer tools: versions and disk usage.
    await page.getByTestId('settings-tab-environment').click();
    await expect(page.getByTestId('tool-docker')).toContainText('v4.37.1');
    await expect(page.getByTestId('tool-docker')).toHaveAttribute('data-status', 'running');
    await expect(page.getByTestId('tool-devcontainers')).toContainText('Installed');
    await expect(page.getByTestId('tool-wsl')).toContainText('v2.3.24.0');
    await expect(page.getByTestId('disk-qaImage')).toContainText('3 GB');
    await expect(page.getByTestId('disk-workspaceVolume')).toContainText('1.1 GB');

    // Backup: outdated until the first export, then the last export is shown.
    await page.getByTestId('settings-tab-backup').click();
    await expect(page.getByTestId('backup-outdated')).toHaveText('Backup outdated');
    await expect(page.getByTestId('last-export')).toContainText('Never exported');
    await expect(page.getByTestId('campaign-progress')).toHaveText('0 tickets completed · SD-214 (To Do)');
    const file = join(saves, 'bug-detective-2026-10-27.bdsave');
    await app.evaluate(({ dialog }, path) => {
      dialog.showSaveDialog = (async () => ({ canceled: false, filePath: path })) as never;
    }, file);
    await page.getByTestId('export-progress').click();
    await expect(page.getByTestId('toast-info')).toContainText('Progress saved');
    await expect(page.getByTestId('last-export')).toContainText('bug-detective-2026-10-27.bdsave');
    await expect(page.getByTestId('last-export')).toContainText(saves);
    await expect(page.getByTestId('backup-outdated')).toHaveCount(0);
    await expect(page.getByTestId('backup-age')).toHaveCount(0);

    await page.getByTestId('new-game').click();
    await expect(page.getByRole('dialog')).toContainText('Start a new game?');
    await page.getByRole('button', { name: 'Cancel' }).click();

    // About: the app and runtime versions only.
    await page.getByTestId('settings-tab-about').click();
    await expect(page.getByTestId('app-version')).toHaveText(/^v\d+\.\d+\.\d+/);
    await expect(page.getByTestId('settings-pane-about')).toContainText('Chromium');

    // Never git branch names or the number of tickets.
    for (const tab of ['preferences', 'environment', 'backup', 'about']) {
      await page.getByTestId(`settings-tab-${tab}`).click();
      await expect(settings).not.toContainText(/player\/|archive\//);
      await expect(settings).not.toContainText(/\d+ of \d+/);
    }
  } finally {
    await close();
    await rm(saves, { recursive: true, force: true });
  }
});

test('settings explain why backup actions are unavailable', async () => {
  const { page, close } = await launch({ qa: ['passed'], qaDelayMs: 4000 });
  try {
    await startFirstTicket(page);
    await dragCard(page, 1, 'inProgress');
    await dragCard(page, 1, 'inQa');
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('settings-tab-backup').click();
    await expect(page.getByTestId('settings-locked')).toContainText('Actions locked: QA is running');
    await expect(page.getByTestId('export-progress')).toBeDisabled();
    await expect(page.getByTestId('restore-progress')).toBeDisabled();
    await expect(page.getByTestId('new-game')).toBeDisabled();
    await expect(page.getByTestId('settings-locked')).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId('new-game')).toBeEnabled();
  } finally {
    await close();
  }
});

test('settings show Docker stopped with a way to start it', async () => {
  const { page, close } = await launch({ stopDockerAfterUnlock: true });
  try {
    await startFirstTicket(page);
    await expect(page.getByTestId('docker-banner')).toBeVisible({ timeout: 15_000 });
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('settings-tab-environment').click();
    await expect(page.getByTestId('tool-docker')).toHaveAttribute('data-status', 'stopped');
    await expect(page.getByTestId('disk-usage')).toContainText('Start Docker to measure disk usage.');
    await expect(page.getByTestId('clean-leftovers')).toBeDisabled();
    await expect(page.getByTestId('docker-leftovers')).toContainText('Docker is not running: start it to clean up. If Docker Desktop is stuck, restart it.');
    await page.getByTestId('settings-tab-backup').click();
    await expect(page.getByTestId('export-progress')).toBeDisabled();
    await expect(page.getByTestId('remove-docker')).toBeDisabled();
    await expect(page.getByTestId('settings-pane-backup')).toContainText('Start Docker to export or restore your progress.');

    await page.getByTestId('settings-tab-environment').click();
    await page.getByTestId('start-docker').click();
    await expect(page.getByTestId('tool-docker')).toHaveAttribute('data-status', 'running', { timeout: 15_000 });
    await expect(page.getByTestId('disk-qaImage')).toContainText('3 GB');
  } finally {
    await close();
  }
});

test('Docker cleanup: leftovers keep the game, removing everything starts a new game', async () => {
  const { page, close } = await launch();
  try {
    await startFirstTicket(page);
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('settings-tab-environment').click();
    await page.getByTestId('clean-leftovers').click();
    await expect(page.getByTestId('toast-info').filter({ hasText: 'Docker cleanup done: 3 items removed.' })).toBeVisible();

    // Removing everything asks first and lists what goes.
    await page.getByTestId('settings-tab-backup').click();
    await page.getByTestId('remove-docker').click();
    const dialog = page.getByTestId('remove-docker-dialog');
    await expect(dialog).toContainText('This deletes the code in your workspace and starts a new game.');
    await expect(dialog).toContainText('Volumes: your code, the VS Code server, the dependency cache and the QA copy');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);

    await page.getByTestId('remove-docker').click();
    await page.getByTestId('confirm-remove-docker').click();
    await expect(page.getByTestId('toast-info').filter({ hasText: 'Everything Bug Detective created in Docker was removed. A new game has started.' })).toBeVisible();
    // A new game: no ticket on the board, and the downloads are needed again.
    await page.getByTestId('nav-board').click();
    await expect(page.getByTestId('card-1')).toHaveCount(0);
    await page.getByTestId('nav-dashboard').click();
    await expect(page.getByTestId('environment-panel')).toBeVisible();
  } finally {
    await close();
  }
});

test('Docker cleanup lists what Docker could not remove, and why', async () => {
  const { page, close } = await launch({ cleanupFails: ['bugdetective-qa-input'] });
  try {
    await startFirstTicket(page);
    await page.evaluate(() => window.bugDetective.updateSettings({ language: 'pt' }));
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('settings-tab-environment').click();
    await page.getByTestId('clean-leftovers').click();
    const result = page.getByTestId('cleanup-result');
    await expect(result).toContainText('Alguns itens não foram removidos');
    await expect(result).toContainText('2 removidos. O Docker não conseguiu remover 1 item:');
    await expect(result.getByTestId('cleanup-failed')).toHaveText('Volume: bugdetective-qa-inputError response from daemon: bugdetective-qa-input is in use');
    // Leftovers never touch the game: no line about it.
    await expect(result.getByTestId('cleanup-game')).toHaveCount(0);
    await expect(result).toContainText('Se o Docker Desktop parecer travado, reinicie-o');
  } finally {
    await close();
  }
});

test('removing everything keeps the game when Docker could not remove the code', async () => {
  const { page, close } = await launch({ cleanupFails: ['bugdetective-workspace'] });
  try {
    await startFirstTicket(page);
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('settings-tab-backup').click();
    await page.getByTestId('remove-docker').click();
    await page.getByTestId('confirm-remove-docker').click();
    const result = page.getByTestId('cleanup-result');
    // The container and the volume share a name: the kind tells them apart.
    await expect(result.getByTestId('cleanup-failed')).toHaveCount(2);
    await expect(result.getByTestId('cleanup-failed').first()).toContainText('Container: bugdetective-workspace');
    await expect(result.getByTestId('cleanup-failed').last()).toContainText('Volume: bugdetective-workspace');
    await expect(result.getByTestId('cleanup-game')).toHaveText('Your progress was kept: the volume with your code could not be removed.');
    await result.getByRole('button', { name: 'Close' }).last().click();
    await page.getByTestId('nav-board').click();
    await expect(page.getByTestId('card-1')).toBeVisible();
  } finally {
    await close();
  }
});
