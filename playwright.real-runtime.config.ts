import { defineConfig } from '@playwright/test';

/**
 * The suite against the real runtime (Docker Desktop, VS Code): pnpm run test:real-runtime. Windows or
 * Linux/WSL 2; in CI, the self-hosted Windows runner (.github/workflows/real-runtime.yml).
 */
export default defineConfig({
  testDir: 'test/real-runtime',
  workers: 1,
  retries: 0,
  timeout: 90 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  outputDir: 'test-results/real-runtime',
});
