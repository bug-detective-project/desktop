import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { projectCardFixture, snapshotFixture } from '../storybook/fixtures.ts';
import { Projects } from './Projects.tsx';

const both = (text: string) => ({ en: text, pt: text });
const base = projectCardFixture().details!;
const projects = [
  projectCardFixture({ id: 'notes', active: true }),
  projectCardFixture({ id: 'ledger', details: { ...base, name: both('Ledger'), difficulty: 'advanced', stack: { frontend: 'Vue · Vite', backend: 'Python · FastAPI', database: 'PostgreSQL' } } }),
  projectCardFixture({ id: 'stock', details: { ...base, name: both('Stock Room'), difficulty: 'intermediate', stack: { backend: 'Node.js · Express' } } }),
];

const meta = {
  title: 'Screens/Projects',
  parameters: { layout: 'fullscreen' },
  render: () => <Projects snapshot={snapshotFixture('queued', { projects })} />,
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const AllProjects: Story = {};

/** Enter saves each search as a tag; the tags combine. */
export const SearchTags: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('searchbox'), 'vue{Enter}python{Enter}');
    await expect(canvas.getByTestId('project-tags').querySelectorAll('li')).toHaveLength(2);
    await expect(await canvas.findByText('1 project')).toBeVisible();
  },
};

export const NoMatch: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole('searchbox'), 'kotlin');
    await expect(await canvas.findByTestId('projects-empty')).toBeVisible();
  },
};

export const Dark: Story = { globals: { theme: 'dark' } };
export const Portuguese: Story = { globals: { locale: 'pt' } };
