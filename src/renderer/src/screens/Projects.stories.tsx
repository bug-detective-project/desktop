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

/** The catalog could not be refreshed: the last saved list, with the warning and its retry. */
const outdated = () => <Projects snapshot={snapshotFixture('active', { projects, catalogRefresh: { failedAt: '2026-11-04T10:00:00.000Z' } })} />;

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

export const Portuguese: Story = { globals: { locale: 'pt' } };

export const CatalogOutdated: Story = { render: outdated };

/** Switching to a project that needs more memory than Docker has warns, and still lets the player go on. */
const heavy = projectCardFixture({ id: 'ledger', details: { ...base, name: both('Ledger'), memoryBytes: 7.5 * 1024 ** 3 } });
const dockerWith = (memoryBytes: number) => ({ checks: [{ id: 'docker' as const, status: 'ok' as const, version: '4.37.1', memoryBytes }], allOk: true, dockerState: 'running' as const });
export const SwitchNeedsMoreMemory: Story = {
  render: () => <Projects snapshot={snapshotFixture('queued', { projects: [projects[0]!, heavy], prerequisites: dockerWith(4 * 1024 ** 3) })} />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId('switch-ledger'));
    const dialog = within(canvasElement.ownerDocument.body);
    await expect(dialog.getByTestId('switch-memory-warning')).toHaveTextContent('about 7.5 GB');
    await expect(dialog.getByTestId('switch-memory-warning')).toHaveTextContent('Docker has 4 GB');
    await expect(dialog.getByTestId('confirm-switch')).toBeEnabled();
  },
};
export const SwitchWithEnoughMemory: Story = {
  render: () => <Projects snapshot={snapshotFixture('queued', { projects: [projects[0]!, heavy], prerequisites: dockerWith(16 * 1024 ** 3) })} />,
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId('switch-ledger'));
    const dialog = within(canvasElement.ownerDocument.body);
    await expect(dialog.getByTestId('confirm-switch')).toBeVisible();
    await expect(dialog.queryByTestId('switch-memory-warning')).toBeNull();
  },
};
