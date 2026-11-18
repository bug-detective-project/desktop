import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { TICKET_TYPES } from '@shared/ticketMeta.ts';
import { TicketTypeBadge } from './TicketTypeBadge.tsx';

const meta = {
  title: 'Components/TicketTypeBadge',
  component: TicketTypeBadge,
  args: { type: 'fix', bothSides: false },
  decorators: [
    (Story) => (
      <div className="flex items-center gap-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TicketTypeBadge>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A ticket without a ticket.json: a fix ticket, with no both-sides mark. */
export const Fix: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('ticket-type')).toHaveAttribute('data-type', 'fix');
    await expect(canvas.getByTestId('ticket-type')).toHaveTextContent('Fix');
    await expect(canvas.queryByTestId('ticket-both-sides')).toBeNull();
  },
};
export const Build: Story = { args: { type: 'build' } };
export const Complete: Story = { args: { type: 'complete' } };
export const Refactor: Story = { args: { type: 'refactor' } };
export const Optimize: Story = { args: { type: 'optimize' } };
export const Upgrade: Story = { args: { type: 'upgrade' } };
export const Investigate: Story = { args: { type: 'investigate' } };
export const BothSides: Story = {
  args: { type: 'build', bothSides: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('ticket-type')).toHaveTextContent('Build');
    await expect(canvas.getByTestId('ticket-both-sides')).toHaveTextContent('Front + back');
  },
};

/** Every type side by side, as on a board with tickets of each kind. */
export const AllTypes: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      {TICKET_TYPES.map((type) => (
        <TicketTypeBadge key={type} type={type} bothSides={type === 'optimize'} />
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const labels = within(canvasElement)
      .getAllByTestId('ticket-type')
      .map((tag) => tag.textContent);
    await expect(labels).toEqual(['Fix', 'Build', 'Complete', 'Write the test', 'Refactor', 'Optimize', 'Upgrade', 'Investigate']);
  },
};
