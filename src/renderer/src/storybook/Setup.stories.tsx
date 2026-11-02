/** Tests of the stories' own setup (.storybook/preview.tsx): the fake API, the theme and the language. */
import type { Meta, StoryObj } from '@storybook/react-vite';
import { useTranslation } from 'react-i18next';
import { expect, userEvent, waitFor, within } from 'storybook/test';
import { api } from '../api.ts';
import { apiCalls } from './fakeApi.ts';

function Probe() {
  const { t } = useTranslation();
  return (
    <div>
      <h1>{t('projects.title')}</h1>
      <button type="button" onClick={() => void api.loadProjects()}>
        Load
      </button>
    </div>
  );
}

const meta = { title: 'Storybook/Setup', component: Probe } satisfies Meta<typeof Probe>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A method no story configured is recorded and resolves: nothing throws. */
export const UnplannedApiCall: Story = {
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByRole('button', { name: 'Load' }));
    await waitFor(() => expect(apiCalls().map((call) => call.method)).toContain('loadProjects'));
  },
};

/** The toolbar's theme and language reach the story. */
export const DarkPortuguese: Story = {
  globals: { theme: 'dark', locale: 'pt' },
  play: async ({ canvasElement }) => {
    await expect(document.documentElement.classList.contains('dark')).toBe(true);
    await expect(within(canvasElement).getByRole('heading')).toHaveTextContent('Projetos');
  },
};
