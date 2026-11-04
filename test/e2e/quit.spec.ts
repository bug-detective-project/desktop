import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { launch } from './fixtures.ts';

test('closing the window shuts the runtime down once (QA and the workspace container stop) before the app quits', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'João Silva e2e-quit-'));
  try {
    const { app, page } = await launch({}, { userData });
    await expect(page.getByTestId('checklist').or(page.getByTestId('dashboard')).first()).toBeVisible();
    const exited = app.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => {
      for (const window of BrowserWindow.getAllWindows()) window.close();
    });
    await exited;
    const report = JSON.parse(await readFile(join(userData, 'shutdown.json'), 'utf8')) as { shutdownCalls: number };
    expect(report.shutdownCalls).toBe(1);
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});
