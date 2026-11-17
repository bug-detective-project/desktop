import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';
import { snapshotFixture } from '../storybook/fixtures.ts';
import { TicketPanel } from './TicketPanel.tsx';

const meta = { title: 'Screens/TicketPanel', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const InProgress: Story = {
  render: () => <TicketPanel snapshot={snapshotFixture('active')} ticketNumber={1} onClose={fn()} onOpenReview={fn()} />,
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement.ownerDocument.body).findByTestId('ticket-markdown')).toBeVisible();
  },
};
export const InCodeReview: Story = { render: () => <TicketPanel snapshot={snapshotFixture('review')} ticketNumber={1} onClose={fn()} onOpenReview={fn()} /> };
export const Portuguese: Story = { ...InProgress, globals: { locale: 'pt' } };

/** The header says the kind of work of the ticket, and the both-sides mark when it has one. */
export const TicketOfAnotherType: Story = {
  render: () => (
    <TicketPanel
      snapshot={snapshotFixture('active', { ticketMeta: { 1: { type: 'build', bothSides: true } } })}
      ticketNumber={1}
      onClose={fn()}
      onOpenReview={fn()}
    />
  ),
  play: async ({ canvasElement }) => {
    const panel = await within(canvasElement.ownerDocument.body).findByTestId('ticket-panel');
    const header = within(panel.querySelector('header')!);
    await expect(header.getByTestId('ticket-type')).toHaveAttribute('data-type', 'build');
    await expect(header.getByTestId('ticket-both-sides')).toBeVisible();
  },
};
