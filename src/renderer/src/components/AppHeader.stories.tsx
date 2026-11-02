import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { fn } from 'storybook/test';
import { snapshotFixture } from '../storybook/fixtures.ts';
import { AppHeader } from './AppHeader.tsx';

/** Rendered only: the header's code is not part of the stories' work. */
const meta = {
  title: 'Components/AppHeader',
  args: { view: 'dashboard', dark: false, onNavigate: fn(), onOnboarding: fn() },
  render: (args) => <AppHeader {...args} snapshot={snapshotFixture('active')} />,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<Omit<ComponentProps<typeof AppHeader>, 'snapshot'>>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Dashboard: Story = {};
export const Board: Story = { args: { view: 'board' } };
export const Dark: Story = { args: { dark: true }, globals: { theme: 'dark' } };
