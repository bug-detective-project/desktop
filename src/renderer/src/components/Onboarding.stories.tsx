import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { fn } from 'storybook/test';
import { snapshotFixture } from '../storybook/fixtures.ts';
import { Onboarding } from './Onboarding.tsx';

const meta = {
  title: 'Components/Onboarding',
  args: { onNavigate: fn(), onClose: fn() },
  render: (args) => <Onboarding {...args} snapshot={snapshotFixture('queued')} />,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<Omit<ComponentProps<typeof Onboarding>, 'snapshot'>>;
export default meta;
type Story = StoryObj<typeof meta>;
export const FirstTime: Story = { args: { mode: 'first' } };
export const Replay: Story = { args: { mode: 'replay' } };
