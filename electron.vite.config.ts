import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import type { Plugin } from 'vite';
import { rendererAlias, rendererPlugins } from './renderer.config.ts';
import { bundledLicenses } from './tools/notices.ts';

/**
 * The production CSP lives in index.html. Vite's dev server injects inline scripts and styles
 * (React Refresh, HMR), so the dev build relaxes those two directives and allows its websocket.
 */
function devContentSecurityPolicy(): Plugin {
  return {
    name: 'bug-detective-dev-csp',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(
        /<meta http-equiv="Content-Security-Policy" content="[^"]*"/,
        `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws://localhost:* http://localhost:*; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"`,
      );
    },
  };
}

export default defineConfig({
  // Every build records the npm packages it bundles, for out/THIRD_PARTY_NOTICES.md (tools/write-notices.ts).
  main: {
    // React Developer Tools (development only) is left out of the installer: see electron-builder.yml.
    plugins: [bundledLicenses({ skipChunks: /downloadChromeExtension-/ })],
    build: {
      externalizeDeps: true,
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [bundledLicenses()],
    build: {
      // Sandboxed preloads must be CommonJS and self-contained.
      externalizeDeps: false,
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' },
      },
    },
  },
  renderer: {
    root: resolve(import.meta.dirname, 'src/renderer'),
    plugins: [...rendererPlugins(), devContentSecurityPolicy(), bundledLicenses()],
    resolve: { alias: rendererAlias },
    build: {
      // Fonts and images stay files: the CSP allows 'self' only, not data: fonts.
      assetsInlineLimit: 0,
      minify: true,
      rollupOptions: {
        input: { index: resolve(import.meta.dirname, 'src/renderer/index.html') },
      },
    },
  },
});
