import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch } from './fixtures.ts';

test('a build run from source plays like the installed app: no development tools, whatever is set', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'João Silva e2e-'));
  await writeFile(join(userData, 'catalog.local.json'), JSON.stringify({ projects: { supportdesk: { qaRef: 'not-for-players' } } }));
  const { page, close } = await launch({}, { userData, catalogFile: false, env: { BUGDETECTIVE_E2E_PLAYER_RUN: '1', BUGDETECTIVE_DEV_SHOW_PROJECTS: 'true' } });
  try {
    await page.getByTestId('start-playing').click();
    await expect(page.getByTestId('nav-settings')).toBeVisible();
    await expect(page.getByTestId('nav-projects')).toHaveCount(0);
    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('settings-tab-backup')).toBeVisible();
    await expect(page.getByTestId('settings-tab-development')).toHaveCount(0);
  } finally {
    await close();
    await rm(userData, { recursive: true, force: true });
  }
});
