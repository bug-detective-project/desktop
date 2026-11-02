import type { StorybookConfig } from '@storybook/react-vite';
import { mergeConfig } from 'vite';
import { rendererAlias, rendererPlugins } from '../renderer.config.ts';

const config: StorybookConfig = {
  stories: ['../src/renderer/src/**/*.stories.tsx'],
  addons: ['@storybook/addon-a11y', '@storybook/addon-vitest'],
  framework: { name: '@storybook/react-vite', options: {} },
  core: { disableTelemetry: true },
  // The same plugins (React, Tailwind) and aliases as the app's renderer.
  viteFinal: (viteConfig) => mergeConfig(viteConfig, { plugins: rendererPlugins(), resolve: { alias: rendererAlias } }),
};

export default config;
