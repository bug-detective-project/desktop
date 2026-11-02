import type { Meta, StoryObj } from '@storybook/react-vite';
import type { ComponentProps } from 'react';
import { expect, fn, userEvent, within } from 'storybook/test';
import { snapshotFixture } from '../storybook/fixtures.ts';
import { NextAssignmentMenu } from './NextAssignmentMenu.tsx';

const meta = {
  title: 'Components/NextAssignmentMenu',
  args: { disabled: false, onChoose: fn(), testId: 'next' },
  render: (args) => <NextAssignmentMenu {...args} snapshot={snapshotFixture('queued')} />,
} satisfies Meta<Omit<ComponentProps<typeof NextAssignmentMenu>, 'snapshot'>>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Closed: Story = {};

export const Open: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTestId('next'));
    await userEvent.click(canvas.getByTestId('next-assignment-front'));
    await expect(args.onChoose).toHaveBeenCalledWith('front');
  },
};

export const Disabled: Story = { args: { disabled: true } };
