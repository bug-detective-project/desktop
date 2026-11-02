import { resolve } from 'node:path';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        // Every story is a test: it must render and pass axe (pnpm run test:stories).
        plugins: [storybookTest({ configDir: resolve(import.meta.dirname, '.storybook') })],
        test: {
          name: 'stories',
          browser: { enabled: true, headless: true, provider: playwright(), instances: [{ browser: 'chromium' }] },
        },
      },
      {
        test: {
          name: 'integration',
          include: ['test/integration/**/*.test.ts'],
          environment: 'node',
          // Builds images, installs dependencies and runs QA twice in Docker.
          testTimeout: 30 * 60_000,
          hookTimeout: 30 * 60_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
