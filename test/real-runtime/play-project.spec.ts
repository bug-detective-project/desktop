/**
 * Plays a whole game project in the real app (real Docker, real content), the way a player would
 * finish it, with nothing the check does not need: no onboarding, no VS Code, no dev server.
 *
 *   desktop/tools/play-project.sh <project id>
 *
 * The app opens on a fresh data folder with a catalog of that one project, read from its local qa
 * worktree (BD_PLAY_QA_DIR, the publication branch checked out). It installs the environment
 * (workspace, the project's services, the QA image), then, for every ticket of both tracks in
 * order: takes it, moves it to In Progress, applies its reference.patch in the workspace, sends it
 * to QA, and accepts the review once QA passes, until the card is Done. A report with the result
 * and the time of each ticket goes to BD_PLAY_REPORT.
 *
 * Skipped unless BD_PLAY_PROJECT is set, so `pnpm run test:real-runtime` (the PR gate) leaves it out.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { dragCard, takeNextTicket } from '../e2e/fixtures.ts';
import { workspaceDir } from '../../src/main/services/workspace.ts';

const project = process.env.BD_PLAY_PROJECT ?? '';
const qaDir = process.env.BD_PLAY_QA_DIR ?? '';
const reportFile = process.env.BD_PLAY_REPORT ?? '';
const root = resolve(import.meta.dirname, '..', '..');
const DOCKER =
  process.platform === 'win32' ? 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe' : 'docker';
const CONTAINER = 'bugdetective-workspace';

const log = (message: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
const seconds = (since: number) => Math.round((Date.now() - since) / 1000);

interface Played {
  id: string;
  result: 'done' | 'failed' | 'not played';
  seconds: number;
  note?: string;
}

/** The tickets of the publication, front track first, each track in order: front-1, front-2, …, back-1, … */
async function ticketsOf(dir: string): Promise<string[]> {
  const names = (await readdir(join(dir, 'tickets'))).filter((name) => /^(front|back)-\d+$/.test(name));
  const order = (name: string) => [name.startsWith('front') ? 0 : 1, Number(name.split('-')[1])] as const;
  return names.sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1]);
}

/** Installs whatever the environment panel lists, if it is shown. */
async function installEnvironment(page: Page): Promise<void> {
  await page.getByTestId('nav-dashboard').click();
  const report = await page.evaluate(() => window.bugDetective.refreshEnvironment());
  if (report.ready) {
    return;
  }
  const started = Date.now();
  await page.getByTestId('install-environment').click();
  const modal = page.getByTestId('install-modal');
  await expect(modal.getByTestId('install-modal-close')).toBeVisible({ timeout: 30 * 60_000 });
  await expect(modal.getByTestId('install-modal-error')).toHaveCount(0);
  await modal.getByTestId('install-modal-close').click();
  await expect(page.getByTestId('environment-panel')).toHaveCount(0);
  log(`environment installed in ${seconds(started)} s`);
}

async function cardStatus(page: Page, card: number, status: string, timeout: number): Promise<void> {
  await page.getByTestId('nav-board').click();
  await expect(page.getByTestId(`card-${card}`)).toHaveAttribute('data-status', status, { timeout });
}

async function writeReport(played: Played[], started: number): Promise<void> {
  if (!reportFile) {
    return;
  }
  const done = played.filter((ticket) => ticket.result === 'done').length;
  const lines = [
    `# ${project}: played in the desktop`,
    '',
    `${done} of ${played.length} tickets Done in ${Math.round(seconds(started) / 60)} min (${process.platform}, real Docker).`,
    '',
    '| Ticket | Result | Time |',
    '| --- | --- | --- |',
    ...played.map(
      (ticket) =>
        `| \`${ticket.id}\` | ${ticket.result}${ticket.note ? `: ${ticket.note}` : ''} | ${ticket.seconds} s |`,
    ),
    '',
  ];
  await writeFile(reportFile, lines.join('\n'));
}

test.skip(!project || !qaDir, 'BD_PLAY_PROJECT and BD_PLAY_QA_DIR name the project to play (tools/play-project.sh)');

test(`plays every ticket of ${project || 'a project'} to Done`, async () => {
  const started = Date.now();
  const tickets = await ticketsOf(qaDir);
  const played: Played[] = tickets.map((id) => ({ id, result: 'not played', seconds: 0 }));
  const userData = await mkdtemp(join(tmpdir(), `play-${project}-`));
  const catalogFile = join(userData, 'play-catalog.json');
  await writeFile(catalogFile, JSON.stringify({ projects: [{ id: project, qaDir, starter: true }] }));
  const { ELECTRON_RUN_AS_NODE: _ignored, ...parentEnv } = process.env;
  const app = await electron.launch({
    args: [root],
    env: {
      ...parentEnv,
      BUGDETECTIVE_USER_DATA: userData,
      BUGDETECTIVE_CATALOG_FILE: catalogFile,
      BUGDETECTIVE_DEV_SKIP_ONBOARDING_BUTTON: 'true',
    },
  });
  const page = await app.firstWindow();
  const workspace = workspaceDir(project);
  try {
    // The prerequisites are the computer's: this check installs nothing on it.
    await expect(page.getByTestId('start-playing')).toBeEnabled({ timeout: 120_000 });
    await page.getByTestId('start-playing').click();
    await page.getByTestId('onboarding-skip').click();
    await expect(page.getByTestId('onboarding')).toHaveCount(0);
    await installEnvironment(page);

    for (const [index, ticket] of played.entries()) {
      const card = index + 1;
      const ticketStarted = Date.now();
      try {
        await page.getByTestId('nav-dashboard').click();
        await takeNextTicket(page, ticket.id.startsWith('front') ? 'front' : 'back');
        await expect(page.getByTestId('board')).toBeVisible({ timeout: 5 * 60_000 });
        await cardStatus(page, card, 'todo', 120_000);
        await installEnvironment(page);
        await dragCard(page, card, 'inProgress');
        await cardStatus(page, card, 'inProgress', 120_000);

        const patch = await readFile(join(qaDir, 'tickets', ticket.id, 'reference.patch'));
        execFileSync(DOCKER, ['exec', '-i', '-u', 'node', '-w', workspace, CONTAINER, 'git', 'apply', '-'], {
          input: patch,
        });

        await dragCard(page, card, 'inQa');
        // The first QA run builds the project's QA image.
        await cardStatus(page, card, 'codeReview', 20 * 60_000);
        await page.getByTestId(`card-${card}`).click();
        await page.getByTestId('open-review').click();
        await expect(page.getByTestId('review-markdown')).toBeVisible();
        await page.getByTestId('accept-review').click();
        await cardStatus(page, card, 'done', 120_000);
        Object.assign(ticket, { result: 'done', seconds: seconds(ticketStarted) });
        log(`${ticket.id}: Done in ${ticket.seconds} s`);
      } catch (error) {
        Object.assign(ticket, {
          result: 'failed',
          seconds: seconds(ticketStarted),
          note: (error as Error).message.split('\n')[0]!.slice(0, 160),
        });
        throw error;
      }
    }
  } finally {
    await writeReport(played, started);
    await app.close();
  }
  expect(played.every((ticket) => ticket.result === 'done')).toBe(true);
});
