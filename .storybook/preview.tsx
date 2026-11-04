// First: api.ts reads window.bugDetective when it is imported.
import '../src/renderer/src/storybook/installFakeApi.ts';
import '../src/renderer/src/styles.css';
import type { Preview } from '@storybook/react-vite';
import type { Snapshot } from '../src/shared/api.ts';
import i18n from '../src/renderer/src/i18n.ts';
import { installFakeApi } from '../src/renderer/src/storybook/fakeApi.ts';
import type { ApiOverrides } from '../src/renderer/src/storybook/fakeApi.ts';
import { ToastProvider } from '../src/renderer/src/toast.tsx';

/**
 * Every story runs like the app: its styles, translations and toasts, the theme and the language
 * of the toolbar, and a fake window.bugDetective (parameters.api, parameters.snapshot). The stories
 * are also tests (pnpm run test:stories): each must render and pass axe.
 */
const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'Theme',
      toolbar: { title: 'Theme', icon: 'mirror', items: ['light', 'dark'], dynamicTitle: true },
    },
    locale: {
      description: 'Language',
      toolbar: { title: 'Language', icon: 'globe', items: ['en', 'pt'], dynamicTitle: true },
    },
  },
  // The stories test project sets the theme (every story runs in both); interactive Storybook starts light.
  initialGlobals: { theme: typeof __STORY_THEME__ === 'string' ? __STORY_THEME__ : 'light', locale: 'en' },
  parameters: {
    a11y: { test: 'error' },
    layout: 'padded',
  },
  async beforeEach({ globals, parameters }) {
    document.documentElement.classList.toggle('dark', globals.theme === 'dark');
    await i18n.changeLanguage(globals.locale === 'pt' ? 'pt' : 'en');
    installFakeApi(parameters.api as ApiOverrides | undefined, (parameters.snapshot as Snapshot | undefined) ?? null);
  },
  decorators: [
    (Story) => (
      <ToastProvider>
        <div className="bg-background text-foreground">
          <Story />
        </div>
      </ToastProvider>
    ),
  ],
};

export default preview;
