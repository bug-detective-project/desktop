import { resolve } from 'node:path';
import { storybookTest } from '@storybook/addon-vitest/vitest-plugin';
import { playwright } from '@vitest/browser-playwright';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // pnpm run test:coverage: the unit tests and the stories, over the app's code. The thresholds
    // are the floor of that run (measured minus two points; raise them when coverage rises).
    // pnpm run test:coverage:full adds the integration tests and passes its own, higher thresholds
    // on the command line (.github/workflows/ci.yml).
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      exclude: [
        'src/**/*.stories.tsx',
        'src/renderer/src/storybook/**',
        'src/**/*.d.ts',
        // Not code: the renderer's HTML entry point and the locale files (the provider cannot
        // parse them and would warn).
        'src/**/*.html',
        'src/**/*.json',
        // Only reachable inside Electron: covered by the e2e tests, which do not report coverage.
        'src/main/index.ts',
        'src/main/ipc.ts',
        'src/preload/**',
        'src/renderer/src/App.tsx',
        'src/renderer/src/main.tsx',
      ],
      reporter: ['text-summary', 'json-summary', 'html'],
      thresholds: { lines: 70, branches: 65, functions: 59 },
    },
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/unit/**/*.test.ts'],
          environment: 'node',
          // Some tests build git repositories and play whole tickets: slow on a loaded CI runner.
          testTimeout: 30_000,
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
