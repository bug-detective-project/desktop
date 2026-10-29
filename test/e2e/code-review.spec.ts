import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { dragCard, launch, startFirstTicket } from './fixtures.ts';

/** Unlocks ticket 1, passes QA and opens its Code Review page. */
async function reachCodeReview(page: Page): Promise<void> {
  await startFirstTicket(page);
  await dragCard(page, 1, 'inProgress');
  await dragCard(page, 1, 'inQa');
  await expect(page.getByTestId('card-1')).toHaveAttribute('data-status', 'codeReview', { timeout: 15_000 });
  await page.getByTestId('card-1').click();
  // In Code Review the button takes the stage color and the whole row of the panel header.
  const button = page.getByTestId('open-review');
  await expect(button).toHaveClass(/bg-indigo-600/);
  const [buttonBox, actionsBox] = await Promise.all([button.boundingBox(), page.getByTestId('open-vscode').locator('../..').boundingBox()]);
  expect(Math.round(buttonBox!.width)).toBe(Math.round(actionsBox!.width));
  await button.click();
  await expect(page.getByTestId('code-review')).toBeVisible();
}

const file = (page: Page, path: string) => page.locator(`[data-testid="comparison"] [data-testid="comparison-file"][data-path="${path}"]`);

test('the review keeps the explanation on top and compares the two solutions file by file', async () => {
  const { page, close } = await launch({ qa: ['passed'] });
  try {
    await reachCodeReview(page);
    // Back and Accept sit below the title; the diff dropdown titles are 16px.
    const title = await page.getByTestId('code-review').locator('header h1').boundingBox();
    const actions = await page.getByTestId('review-actions').boundingBox();
    expect(actions!.y).toBeGreaterThanOrEqual(title!.y + title!.height);
    expect(actions!.x).toBe(title!.x);
    await expect(page.getByTestId('review-comparison').locator('summary h2')).toHaveCSS('font-size', '16px');
    await expect(page.getByTestId('review-reference').locator('summary h2')).toHaveCSS('font-size', '16px');
    const explanation = await page.getByTestId('review-markdown').boundingBox();
    const comparison = await page.getByTestId('review-comparison').boundingBox();
    const reference = await page.getByTestId('review-reference').boundingBox();
    expect(explanation!.y).toBeLessThan(comparison!.y);
    expect(comparison!.y).toBeLessThan(reference!.y);

    // Both dropdowns start open; only the comparison opens the review in VS Code.
    await expect(page.getByTestId('review-comparison')).toHaveJSProperty('open', true);
    await expect(page.getByTestId('review-reference')).toHaveJSProperty('open', true);
    await expect(page.getByTestId('review-reference').getByTestId('open-review-vscode')).toHaveCount(0);
    const referenceFile = page.locator('[data-testid="reference-diff"] [data-testid="comparison-file"][data-path="client/src/pages/TicketDetails.tsx"]');
    await expect(referenceFile.locator('thead')).toContainText('Original code');
    await expect(referenceFile.locator('thead')).toContainText('Reference solution');
    await page.getByTestId('review-reference').locator('summary').click();
    await expect(page.getByTestId('review-reference')).toHaveJSProperty('open', false);
    await expect(page.getByTestId('reference-diff')).toBeHidden();

    // Only differing files, matched by path; one-sided files, renames and binaries are labeled.
    const list = page.getByTestId('comparison-files');
    await expect(list).toContainText('7 files differ');
    await expect(file(page, 'client/src/api/errors.ts')).toContainText('Only in your solution');
    await expect(file(page, 'client/src/pages/TicketDetails.assignment.test.tsx')).toContainText('Only in the reference');
    await expect(file(page, 'client/src/utils/helpers.ts')).toContainText('client/src/helpers.ts → client/src/utils/helpers.ts');
    await expect(file(page, 'client/public/logo.png')).toContainText('Binary file differs');

    // Split view: your solution on the left, the reference on the right, lines aligned.
    const details = file(page, 'client/src/pages/TicketDetails.tsx');
    await expect(details.locator('thead')).toContainText('Your solution');
    await expect(details.locator('thead')).toContainText('Reference solution');
    const changed = details.locator('[data-testid="split-row"][data-left="del"][data-right="add"]');
    await expect(changed).toHaveCount(1);
    await expect(changed.locator('td').nth(1)).toContainText('{employees.map(');
    await expect(changed.locator('td').nth(3)).toContainText('{activeEmployees.map(');

    // Collapsible, and very large diffs wait for "Load diff".
    await details.getByRole('button').first().click();
    await expect(details.locator('table')).toHaveCount(0);
    const large = file(page, 'client/src/generated/rows.ts');
    await expect(large.locator('table')).toHaveCount(0);
    await large.getByTestId('load-diff').click();
    await expect(large.locator('table')).toBeVisible();

    // Whitespace-only differences are hidden until the toggle reveals them.
    await expect(file(page, 'client/src/searchParams.ts')).toHaveCount(0);
    await page.getByTestId('whitespace-toggle').check();
    await expect(file(page, 'client/src/searchParams.ts')).toBeVisible();
    await expect(list).toContainText('8 files differ');
  } finally {
    await close();
  }
});

test('an identical solution says so and shows the player changes against the original code', async () => {
  const { page, close } = await launch({ qa: ['passed'], review: 'identical' });
  try {
    await reachCodeReview(page);
    await expect(page.getByTestId('identical-message')).toHaveText('Your solution is identical to the reference');
    await expect(page.getByTestId('baseline-diff')).toContainText('client/src/pages/TicketDetails.tsx');
    await expect(page.getByTestId('comparison')).toHaveCount(0);
    // The reference diff would repeat the same changes: it is not shown.
    await expect(page.getByTestId('review-reference')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('Open Review in VS Code shows the banner until the player goes back to their code, in Code Review and in Done', async () => {
  const { page, close } = await launch({ qa: ['passed'] });
  try {
    await reachCodeReview(page);
    const button = page.getByTestId('open-review-vscode');
    await expect(button).toHaveText('Open Review in VS Code');
    // The info icon beside it explains how to reach the diff in VS Code.
    // Only hovering the button or the icon shows the steps; a click (focus) does not keep them open.
    const steps = page.getByTestId('vscode-steps');
    await expect(steps).toBeHidden();
    await page.getByTestId('vscode-steps-info').hover();
    await expect(steps).toBeVisible();
    await page.getByTestId('whitespace-toggle').hover();
    await expect(steps).toBeHidden();
    await button.hover();
    await expect(steps).toBeVisible();
    await page.getByTestId('review-markdown').hover();
    await expect(steps).toBeHidden();
    await button.hover();
    await expect(page.getByTestId('vscode-steps')).toContainText('In the Graph section, click the top commit, "Your approved solution"');
    await expect(page.getByTestId('vscode-steps').locator('li')).toHaveCount(4);
    await button.click();
    await page.getByTestId('review-markdown').hover();
    await expect(steps).toBeHidden(); // the focused button does not keep the steps open
    const banner = page.getByTestId('review-banner');
    await expect(banner).toContainText('Viewing the review of ticket SD-214 in VS Code. Your code will be restored automatically.');
    await expect(page.locator('body')).not.toContainText(/review\/|player\/|review-edits\//);
    await page.getByTestId('back-to-my-code').click();
    await expect(banner).toHaveCount(0);

    // Accepting returns first; the button stays available once the ticket is Done.
    await button.click();
    await expect(banner).toBeVisible();
    await page.getByTestId('accept-review').click();
    await expect(page.getByTestId('board')).toBeVisible();
    await expect(banner).toHaveCount(0);
    await page.getByTestId('card-1').click();
    await page.getByTestId('open-review').click();
    await expect(page.getByTestId('accept-review')).toHaveCount(0);
    await expect(page.getByTestId('open-review-vscode')).toBeEnabled();
    await page.getByTestId('open-review-vscode').click();
    await expect(banner).toBeVisible();
  } finally {
    await close();
  }
});

test('when VS Code cannot open, the player code comes back and the reason is shown', async () => {
  const { page, close } = await launch({ qa: ['passed'], vscodeFails: true });
  try {
    await reachCodeReview(page);
    await page.getByTestId('open-review-vscode').click();
    await expect(page.getByTestId('toast-error')).toContainText('VS Code could not be opened, and your code was restored: VS Code was not found');
    await expect(page.getByTestId('review-banner')).toHaveCount(0);
  } finally {
    await close();
  }
});

test('the review texts are in Portuguese', async () => {
  const { page, close } = await launch({ qa: ['passed'] });
  try {
    await reachCodeReview(page);
    await page.evaluate(() => window.bugDetective.updateSettings({ language: 'pt' }));
    await expect(page.getByTestId('open-review-vscode')).toHaveText('Abrir review no VS Code');
    await expect(file(page, 'client/src/api/errors.ts')).toContainText('Somente na sua solução');
    await expect(file(page, 'client/src/pages/TicketDetails.tsx').locator('thead')).toContainText('Solução de referência');
    await expect(page.getByTestId('review-comparison').locator('summary')).toHaveText('Diff sua solução com a solução proposta');
    await expect(page.getByTestId('review-reference').locator('summary')).toHaveText('Diff solução proposta com o código original');
    // The commits are always named in English, so the Portuguese steps quote the English names.
    await expect(page.getByTestId('vscode-steps')).toContainText('clique no commit do topo, "Your approved solution"');
    await expect(page.getByTestId('vscode-steps')).toContainText('"Reference"');
    await page.getByTestId('open-review-vscode').click();
    await expect(page.getByTestId('review-banner')).toContainText('Você está vendo o review do ticket SD-214 no VS Code. Seu código será restaurado automaticamente.');
  } finally {
    await close();
  }
});
