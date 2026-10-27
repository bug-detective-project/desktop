import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { dragCard, launch, startFirstTicket } from './fixtures.ts';

test('settings: preferences, developer tools, backup and about tabs', async () => {
  const { app, page, close } = await launch();
  const saves = await mkdtemp(join(tmpdir(), 'Meus saves '));
  try {
    await startFirstTicket(page);
    await page.getByTestId('nav-settings').click();
    const settings = page.getByTestId('settings');

    // Preferences: language and theme apply at once.
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
    await page.getByTestId('settings-tab-backup').click();
    await expect(page.getByTestId('export-progress')).toBeDisabled();
    await expect(page.getByTestId('settings-pane-backup')).toContainText('Start Docker to export or restore your progress.');

    await page.getByTestId('settings-tab-environment').click();
    await page.getByTestId('start-docker').click();
    await expect(page.getByTestId('tool-docker')).toHaveAttribute('data-status', 'running', { timeout: 15_000 });
    await expect(page.getByTestId('disk-qaImage')).toContainText('3 GB');
  } finally {
    await close();
  }
});
