/**
 * The renderer's Vite plugins and aliases, shared by electron.vite.config.ts (the app) and
 * .storybook/main.ts (the stories), so both build the components the same way.
 */
import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import type { PluginOption } from 'vite';

export const rendererAlias = { '@shared': resolve(import.meta.dirname, 'src/shared') };

export function rendererPlugins(): PluginOption[] {
  return [react(), tailwindcss()];
}
