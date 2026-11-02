import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dragCard, launch, startFirstTicket, supportdeskQa, takeNextTicket } from './fixtures.ts';
import { supportdesk } from './content.ts';

/** Plays an unlocked ticket to Done with the fake QA passing. */
async function finish(page: Page, ticket: number) {
  await dragCard(page, ticket, 'inProgress');
  await dragCard(page, ticket, 'inQa');
  await expect(page.getByTestId(`card-${ticket}`)).toHaveAttribute('data-status', 'codeReview', { timeout: 15_000 });
  await page.getByTestId('nav-dashboard').click();
  await page.getByTestId('desk-primary').click();
  await page.getByTestId('accept-review').click();
  await expect(page.getByTestId(`card-${ticket}`)).toHaveAttribute('data-status', 'done');
}

test('Projects shows up once a track is done, with each project, its difficulty and progress', async () => {
  test.setTimeout(120_000);
  const { page, close } = await launch({ qa: ['passed'] });
  try {
    await startFirstTicket(page);
    await expect(page.getByTestId('nav-projects')).toHaveCount(0);
    await finish(page, 1);
    for (let ticket = 2; ticket <= supportdesk.counts.front; ticket++) {
      await page.getByTestId('nav-dashboard').click();
      await takeNextTicket(page, 'front');
      await expect(page.getByTestId(`card-${ticket}`)).toHaveAttribute('data-status', 'todo');
      await finish(page, ticket);
    }
    // The front track is done, so the project is done: Projects appears and stays.
    await expect(page.getByTestId('nav-projects')).toBeVisible();
    await page.getByTestId('nav-projects').click();
    const card = page.getByTestId('project-supportdesk');
    await expect(card).toContainText(supportdesk.story.en.project.name);
    await expect(card.getByTestId('project-current')).toHaveText('Current project');
    await expect(card.getByTestId('project-difficulty')).toContainText(`${supportdesk.difficulty![0].toUpperCase()}${supportdesk.difficulty!.slice(1)}`);
    await expect(card.getByTestId('project-tickets').first()).toHaveText(`Front ${supportdesk.counts.front}/${supportdesk.counts.front} · Back 0/${supportdesk.counts.back}`);
    // The active project has no switch button, only its brief.
    await expect(page.getByTestId('switch-supportdesk')).toHaveCount(0);
    await expect(page.getByTestId('project-supportdesk-brief')).toBeEnabled();
  } finally {
    await close();
  }
});

const supportdeskEntry = { id: 'supportdesk', qaDir: supportdeskQa, starter: true };
// A second project that is never downloaded in these tests (its folder does not exist).
const inventory = { id: 'inventory', qaDir: '/nonexistent/inventory-qa' };
const showProjects = { BUGDETECTIVE_DEV_SHOW_PROJECTS: 'true' };

test('a project that needs a newer app says so, and cannot be chosen', async () => {
  const { page, close } = await launch({}, { env: showProjects, catalog: [supportdeskEntry, { ...inventory, minAppVersion: '99.0.0' }] });
  try {
    await page.getByTestId('start-playing').click();
    await page.getByTestId('nav-projects').click();
    const card = page.getByTestId('project-inventory');
    await expect(card.getByTestId('project-needs-update')).toHaveText('Update Bug Detective to play this project.');
    await expect(card.getByTestId('switch-inventory')).toBeDisabled();
    await expect(page.getByTestId('project-supportdesk').getByTestId('project-needs-update')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('a hidden project does not show on the Projects screen', async () => {
  const { page, close } = await launch({}, { env: showProjects, catalog: [supportdeskEntry, { ...inventory, hidden: true }] });
  try {
    await page.getByTestId('start-playing').click();
    await page.getByTestId('nav-projects').click();
    await expect(page.getByTestId('project-supportdesk')).toBeVisible();
    await expect(page.getByTestId('project-inventory')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('a new game whose first project needs a newer app cannot start', async () => {
  const { page, close } = await launch({}, { catalog: [{ ...supportdeskEntry, minAppVersion: '99.0.0' }] });
  try {
    await expect(page.getByTestId('starter-needs-update')).toHaveText('Update Bug Detective to start playing. The first project needs a newer version of the app.');
    await expect(page.getByTestId('start-playing')).toBeDisabled();
  } finally {
    await close();
  }
});

test('a game in progress whose project now needs a newer app shows a notice and goes on', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'João Silva e2e-'));
  try {
    const first = await launch({}, { userData });
    try {
      await startFirstTicket(first.page);
    } finally {
      await first.close();
    }
    const second = await launch({}, { userData, catalog: [{ ...supportdeskEntry, minAppVersion: '99.0.0' }] });
    try {
      await second.page.getByTestId('nav-dashboard').click();
      await expect(second.page.getByTestId('project-needs-update')).toContainText('Update Bug Detective: this project needs a newer version of the app.');
      await second.page.getByTestId('nav-board').click();
      await expect(second.page.getByTestId('card-1')).toHaveAttribute('data-status', 'todo');
    } finally {
      await second.close();
    }
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

