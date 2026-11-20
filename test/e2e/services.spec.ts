import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createNotesProject } from '../helpers/notes-project.ts';
import { launch } from './fixtures.ts';

const services = {
  db: {
    image: 'postgres:17',
    env: { POSTGRES_PASSWORD: 'notes' },
    variables: { DATABASE_URL: 'postgres://postgres:notes@{{host}}:{{port}}/postgres' },
  },
};

/** The notes project with a PostgreSQL declared in its qa package.json (the fake runtime stands in for Docker). */
async function notesWithServices(dir: string): Promise<string> {
  const notes = await createNotesProject(dir);
  const file = join(notes.qaDir, 'package.json');
  const json = JSON.parse(await readFile(file, 'utf8'));
  json.bugDetective.project.services = services;
  await writeFile(file, `${JSON.stringify(json, null, 2)}\n`);
  execFileSync('git', ['commit', '-q', '-am', 'Declare the database'], { cwd: notes.qaDir });
  return notes.qaDir;
}

test('the Dashboard lists the services of the project, by name and image, with their state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bd-services-'));
  const qaDir = await notesWithServices(dir);
  const { page, close } = await launch({}, { catalog: [{ id: 'notes', qaDir, starter: true }] });
  try {
    await page.getByTestId('start-playing').click();
    await page.getByTestId('next-assignment').click();
    await page.getByTestId('next-assignment-front').click();
    await expect(page.getByTestId('card-1')).toBeVisible();

    await page.getByTestId('nav-dashboard').click();
    const row = page.getByTestId('env-service-db');
    await expect(row).toContainText('db · postgres:17');
    await expect(row).toContainText('Ready');
    await expect(row).toHaveAttribute('data-tone', 'ok');
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a service that does not start is shown with its reason, and the game goes on', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bd-services-'));
  const qaDir = await notesWithServices(dir);
  const scenario = { serviceFailure: { name: 'db', reason: 'Error: superuser password is not specified.' } };
  const { page, close } = await launch(scenario, { catalog: [{ id: 'notes', qaDir, starter: true }] });
  try {
    await page.getByTestId('start-playing').click();
    await page.getByTestId('next-assignment').click();
    await page.getByTestId('next-assignment-front').click();
    await expect(page.getByTestId('card-1')).toBeVisible();

    await page.getByTestId('nav-dashboard').click();
    const row = page.getByTestId('env-service-db');
    await expect(row).toContainText('Stopped: Error: superuser password is not specified.');
    await expect(row).toHaveAttribute('data-tone', 'danger');

    // The rest of the app stays usable: the Board opens and the ticket can be started.
    await page.getByTestId('nav-board').click();
    await page.getByTestId('card-1').click();
    await expect(page.getByTestId('ticket-panel')).toBeVisible();
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});
