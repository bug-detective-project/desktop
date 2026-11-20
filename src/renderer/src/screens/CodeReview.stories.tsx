import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';
import { snapshotFixture } from '../storybook/fixtures.ts';
import { CodeReview } from './CodeReview.tsx';

const meta = { title: 'Screens/CodeReview', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Comparison: Story = {
  render: () => <CodeReview snapshot={snapshotFixture('review')} ticketNumber={1} onBack={fn()} />,
};

/** The introduction of the reference solution follows the kind of ticket: here, nothing was a bug. */
export const ReferenceOfABuildTicket: Story = {
  render: () => (
    <CodeReview
      snapshot={snapshotFixture('review', { ticketMeta: { 1: { type: 'build', bothSides: false } } })}
      ticketNumber={1}
      onBack={fn()}
    />
  ),
  play: async ({ canvasElement }) => {
    const intro = await within(canvasElement.ownerDocument.body).findByTestId('review-reference-intro');
    await expect(intro).toHaveTextContent('to deliver what the ticket asks.');
    await expect(intro).not.toHaveTextContent(/bug/i);
  },
};

export const ReferenceOfAFixTicket: Story = {
  render: () => <CodeReview snapshot={snapshotFixture('review')} ticketNumber={1} onBack={fn()} />,
  play: async ({ canvasElement }) => {
    const intro = await within(canvasElement.ownerDocument.body).findByTestId('review-reference-intro');
    await expect(intro).toHaveTextContent('to fix the bug.');
  },
};
