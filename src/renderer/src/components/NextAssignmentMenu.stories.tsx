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

/** The next front ticket is a build ticket that touches both sides: the menu says so before the player takes it. */
export const NextTicketOfAnotherType: Story = {
  render: (args) => <NextAssignmentMenu {...args} snapshot={snapshotFixture('active')} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTestId('next'));
    const front = within(canvas.getByTestId('next-assignment-front'));
    await expect(front.getByTestId('ticket-type')).toHaveAttribute('data-type', 'build');
    await expect(front.getByTestId('ticket-both-sides')).toBeVisible();
    const back = within(canvas.getByTestId('next-assignment-back'));
    await expect(back.getByTestId('ticket-type')).toHaveAttribute('data-type', 'fix');
    await expect(back.queryByTestId('ticket-both-sides')).toBeNull();
  },
};
