import type { Meta, StoryObj } from '@storybook/react-vite';
import { userEvent, within } from 'storybook/test';
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
export const Portuguese: Story = { globals: { locale: 'pt' } };
