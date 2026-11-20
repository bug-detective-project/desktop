import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createNotesProject } from '../helpers/notes-project.ts';
import { launch } from './fixtures.ts';

const ports = {
  client: { port: 5173, open: true, label: { en: 'Notes', pt: 'Notas' } },
  api: { port: 3001 },
  audit: {
    port: 3002,
    open: true,
    label: { en: 'Audit service', pt: 'Serviço de auditoria' },
    variables: { AUDIT_URL: 'http://localhost:{{port}}' },
  },
};

/** The notes project declaring three ports in its qa package.json (the fake runtime stands in for Docker). */
async function notesWithPorts(dir: string): Promise<string> {
  const notes = await createNotesProject(dir);
  const file = join(notes.qaDir, 'package.json');
  const json = JSON.parse(await readFile(file, 'utf8'));
  json.bugDetective.project.ports = ports;
  await writeFile(file, `${JSON.stringify(json, null, 2)}\n`);
  execFileSync('git', ['commit', '-q', '-am', 'Declare the ports'], { cwd: notes.qaDir });
  return notes.qaDir;
}

test('the Dashboard lists the ports the project declares, and opens one marked open', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bd-ports-'));
  const userData = await mkdtemp(join(tmpdir(), 'bd-ports-user-'));
  const qaDir = await notesWithPorts(dir);
  const { page, close } = await launch({}, { userData, catalog: [{ id: 'notes', qaDir, starter: true }] });
  try {
    await page.getByTestId('start-playing').click();
    await page.getByTestId('next-assignment').click();
    await page.getByTestId('next-assignment-front').click();
    await expect(page.getByTestId('card-1')).toBeVisible();

    await page.getByTestId('nav-dashboard').click();
    await expect(page.getByTestId('env-port-client')).toContainText('Notes');
    await expect(page.getByTestId('env-port-client')).toContainText('localhost:5173');
    await expect(page.getByTestId('env-port-api')).toContainText('localhost:3001');
    await expect(page.getByTestId('env-port-audit')).toContainText('Audit service');
    await expect(page.getByTestId('env-port-audit')).toContainText('localhost:3002');
    await expect(page.getByTestId('open-port-client')).toHaveCount(0);
    await expect(page.getByTestId('open-port-api')).toHaveCount(0);

    await page.getByTestId('open-port-audit').click();
    await expect
      .poll(() => readFile(join(userData, 'opened-urls.log'), 'utf8').catch(() => ''))
      .toContain('http://127.0.0.1:3002/');
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
    await rm(userData, { recursive: true, force: true });
  }
});

test('a project without declared ports shows no port rows', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bd-ports-'));
  const notes = await createNotesProject(dir);
  const { page, close } = await launch({}, { catalog: [{ id: 'notes', qaDir: notes.qaDir, starter: true }] });
  try {
    await page.getByTestId('start-playing').click();
    await page.getByTestId('next-assignment').click();
    await page.getByTestId('next-assignment-front').click();
    await expect(page.getByTestId('card-1')).toBeVisible();

    await page.getByTestId('nav-dashboard').click();
    await expect(page.getByTestId('environment-card')).toBeVisible();
    await expect(page.locator('[data-testid^="env-port-"]')).toHaveCount(0);
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});
