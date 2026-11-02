import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { launch, supportdeskQa, takeNextTicket } from './fixtures.ts';

async function openDevelopment(page: Page): Promise<void> {
  await page.getByTestId('start-playing').click();
  await page.getByTestId('nav-settings').click();
  await page.getByTestId('settings-tab-development').click();
  await expect(page.getByTestId('settings-pane-development')).toBeVisible();
}

/** A data folder with a catalog file of its own; `qaDir` is SupportDesk's folder in it. */
async function dataFolder(qaDir: string): Promise<{ userData: string; catalog: string }> {
  const userData = await mkdtemp(join(tmpdir(), 'João Silva e2e-'));
  const catalog = join(userData, 'dev-catalog.json');
  await writeFile(catalog, JSON.stringify({ projects: [{ id: 'supportdesk', qaDir, starter: true }] }));
  return { userData, catalog };
}

test('development settings: the tab shows the catalog in use, in English and Portuguese, and the test variable wins', async () => {
  const { page, close } = await launch();
  try {
    await openDevelopment(page);
    const pane = page.getByTestId('settings-pane-development');
    await expect(pane.getByRole('heading', { level: 2 }).first()).toHaveText('Development');
    await expect(page.getByTestId('dev-catalog-test-file')).toBeVisible();
    await expect(page.getByTestId('dev-catalog-in-use')).toContainText('file ');
    await expect(page.getByTestId('dev-project-supportdesk-source')).toHaveText(`local: ${supportdeskQa}`);
    await expect(page.getByTestId('dev-catalog-apply')).toBeDisabled();
    await expect(page.getByTestId('dev-catalog-reset')).toBeDisabled();
    await page.getByTestId('settings-tab-preferences').click();
    await page.getByTestId('language-pt').click();
    await page.getByTestId('settings-tab-development').click();
    await expect(pane.getByRole('heading', { level: 2 }).first()).toHaveText('Desenvolvimento');
    await expect(page.getByTestId('dev-catalog-apply')).toHaveText('Aplicar');
  } finally {
    await close();
  }
});

test('development settings: a local folder applies without a restart, and the next ticket comes from it', async () => {
  const { userData, catalog } = await dataFolder(join(tmpdir(), 'no-such-qa-folder'));
  const { page, close } = await launch({}, { userData, catalogFile: false, localCatalog: { catalog: { file: catalog } } });
  try {
    await openDevelopment(page);
    await expect(page.getByTestId('dev-catalog-source-file')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('dev-catalog-file')).toHaveValue(catalog);
    await page.getByTestId('dev-project-supportdesk-folder').click();
    await page.getByTestId('dev-project-supportdesk-folder-path').fill(supportdeskQa);
    await page.getByTestId('dev-catalog-apply').click();
    await expect(page.getByTestId('dev-project-supportdesk-source')).toHaveText(`local: ${supportdeskQa}`);
    const saved = JSON.parse(await readFile(join(userData, 'catalog.local.json'), 'utf8'));
    expect(saved).toEqual({ catalog: { file: catalog }, projects: { supportdesk: { qaDir: supportdeskQa } } });

    await page.getByTestId('nav-dashboard').click();
    await takeNextTicket(page);
    await expect(page.getByTestId('card-1')).toBeVisible();
  } finally {
    await close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('development settings: Restore defaults deletes the file and goes back to the official catalog', async () => {
  const { userData, catalog } = await dataFolder(supportdeskQa);
  const { page, close } = await launch({}, { userData, catalogFile: false, localCatalog: { catalog: { file: catalog } } });
  try {
    await openDevelopment(page);
    await page.getByTestId('dev-catalog-reset').click();
    await expect(page.getByTestId('dev-catalog-source-official')).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByTestId('dev-catalog-in-use')).toContainText('official');
    expect(existsSync(join(userData, 'catalog.local.json'))).toBe(false);
  } finally {
    await close();
    await rm(userData, { recursive: true, force: true });
  }
});

test('development settings: a broken file opens with its error, and Apply writes over it', async () => {
  const { userData, catalog } = await dataFolder(supportdeskQa);
  const { page, close } = await launch({}, { userData, catalogFile: false, localCatalog: '{' });
  try {
    await openDevelopment(page);
    await expect(page.getByTestId('dev-catalog-error')).toContainText('catalog.local.json');
    await expect(page.getByTestId('dev-catalog-source-official')).toHaveAttribute('aria-checked', 'true');
    await page.getByTestId('dev-catalog-source-file').click();
    await page.getByTestId('dev-catalog-file').fill(catalog);
    await page.getByTestId('dev-catalog-apply').click();
    await expect(page.getByTestId('dev-catalog-error')).toHaveCount(0);
    await expect(page.getByTestId('dev-catalog-in-use')).toContainText(`file ${catalog}`);
    expect(JSON.parse(await readFile(join(userData, 'catalog.local.json'), 'utf8'))).toEqual({ catalog: { file: catalog } });
  } finally {
    await close();
    await rm(userData, { recursive: true, force: true });
  }
});
