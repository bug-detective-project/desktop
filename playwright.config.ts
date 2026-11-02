import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'test/e2e',
  // Finds SupportDesk: ../supportdesk-qa, or the pinned publication cloned into test/.cache/.
  globalSetup: './test/e2e/global-setup.ts',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],
  outputDir: 'test-results',
});
