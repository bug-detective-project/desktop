import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { snapshotFixture } from '../storybook/fixtures.ts';
import { Board } from './Board.tsx';

const meta = { title: 'Screens/Board', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const TicketInProgress: Story = { render: () => <Board snapshot={snapshotFixture('active')} onOpenTicket={fn()} onOpenReview={fn()} /> };
export const TicketInCodeReview: Story = { render: () => <Board snapshot={snapshotFixture('review')} onOpenTicket={fn()} onOpenReview={fn()} /> };

/** From the keyboard the card's title is its button: Tab reaches it and Enter opens the ticket. */
const openTicket = fn();
export const OpenFromTheKeyboard: Story = {
  render: () => <Board snapshot={snapshotFixture('active')} onOpenTicket={openTicket} onOpenReview={fn()} />,
  play: async ({ canvasElement }) => {
    within(canvasElement).getByTestId('card-1').querySelector<HTMLButtonElement>('[data-testid="card-open"]')!.focus();
    await userEvent.keyboard('{Enter}');
    await expect(openTicket).toHaveBeenCalledWith(1);
  },
};
