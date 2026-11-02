/**
 * Regenerates the data the Storybook stories render (src/renderer/src/storybook/data/): real
 * snapshots of the app playing the neutral notes fixture, with the fake runtime. Skipped unless
 * BUGDETECTIVE_UPDATE_STORY_DATA=1:
 *
 *   BUGDETECTIVE_UPDATE_STORY_DATA=1 pnpm run test:e2e:headless:linux test/e2e/story-fixtures.spec.ts
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { createNotesProject } from '../helpers/notes-project.ts';
import { dragCard, launch, takeNextTicket } from './fixtures.ts';

const out = resolve(import.meta.dirname, '..', '..', 'src', 'renderer', 'src', 'storybook', 'data');

test.skip(process.env.BUGDETECTIVE_UPDATE_STORY_DATA !== '1', 'Only when regenerating the stories data');

test('capture the snapshots the stories render', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bd-story-data-'));
  const notes = await createNotesProject(dir);
  const { page, close } = await launch({ qa: ['gate2', 'passed'] }, { catalog: [{ id: 'notes', qaDir: notes.qaDir, starter: true }] });
  // Temporary folders get random names: stable ones keep the data's diff readable.
  const stable = (text: string) => text.replaceAll(dir, '/tmp/notes-project').replace(/\/tmp\/João Silva e2e-[A-Za-z0-9]+/g, '/tmp/bug-detective-data');
  const save = async (name: string, value: unknown) => writeFile(join(out, `${name}.json`), stable(`${JSON.stringify(value, null, 2)}\n`));
  const snapshot = () => page.evaluate(() => window.bugDetective.snapshot());
  try {
    await page.getByTestId('start-playing').click();
    await expect(page.getByTestId('next-assignment')).toBeVisible();
    await save('snapshot-queued', await snapshot());

    await takeNextTicket(page);
    await page.getByTestId('card-1').waitFor();
    await dragCard(page, 1, 'inProgress');
    await save('snapshot-active', await snapshot());
    await save('ticket-content-en', await page.evaluate(() => window.bugDetective.ticketContent(1, 'en')));
    await save('ticket-content-pt', await page.evaluate(() => window.bugDetective.ticketContent(1, 'pt')));

    // The first QA run fails gate 2, the second passes: the card reaches Code Review.
    await dragCard(page, 1, 'inQa');
    await expect(page.getByTestId('card-1')).toHaveAttribute('data-status', 'inProgress', { timeout: 15_000 });
    await dragCard(page, 1, 'inQa');
    await expect(page.getByTestId('card-1')).toHaveAttribute('data-status', 'codeReview', { timeout: 15_000 });
    await save('snapshot-review', await snapshot());
    await save('review-comparison', await page.evaluate(() => window.bugDetective.reviewComparison(1)));
  } finally {
    await close();
    await rm(dir, { recursive: true, force: true });
  }
});
