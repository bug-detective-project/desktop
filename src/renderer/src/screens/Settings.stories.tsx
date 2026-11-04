import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, userEvent, within } from 'storybook/test';
import { snapshotFixture } from '../storybook/fixtures.ts';
import { Settings } from './Settings.tsx';

const meta = { title: 'Screens/Settings', parameters: { layout: 'fullscreen' }, render: () => <Settings snapshot={snapshotFixture('active')} /> } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const tab = (id: string): Story => ({
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId(`settings-tab-${id}`));
  },
});

export const Preferences: Story = {};
export const DeveloperTools: Story = tab('environment');
export const ProgressAndBackup: Story = tab('backup');
export const About: Story = tab('about');
export const Development: Story = tab('development');
const foreignSave = { token: '00000000-0000-4000-8000-000000000001', summary: { fileName: 'bug-detective-2026-11-04.bdsave', createdAt: '2026-11-04T10:00:00.000Z', appVersion: '0.1.0', ticketsDone: 2, currentTicket: 3, overwritesProgress: true, fromThisInstall: false } };

/** Restoring a save made on another computer: the dialog warns that it brings code that will run in the workspace. */
export const RestoreForeignSave: Story = {
  parameters: { api: { inspectSave: async () => foreignSave } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTestId('settings-tab-backup'));
    await userEvent.click(canvas.getByTestId('restore-progress'));
    const dialog = within(canvasElement.ownerDocument.body);
    await expect(dialog.getByTestId('foreign-save-warning')).toHaveTextContent('This backup was created on another computer.');
    await expect(dialog.getByTestId('restore-warning')).toBeVisible();
  },
};
export const RestoreForeignSaveInPortuguese: Story = { ...RestoreForeignSave, globals: { locale: 'pt' }, play: undefined };

export const Portuguese: Story = { globals: { locale: 'pt' } };
