import { resolve } from 'node:path';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // pnpm run test:coverage: the unit tests and the stories, over the app's code.
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: ['src/**/*.stories.tsx', 'src/renderer/src/storybook/**', 'src/**/*.d.ts'],
      reporter: ['text-summary', 'json-summary', 'html'],
    },
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
