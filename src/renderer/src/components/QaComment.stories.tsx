import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import type { QaComment } from '@shared/types.ts';
import { QaCommentView } from './QaComment.tsx';

const comment = (overrides: Partial<QaComment>): QaComment => ({
  id: 'c1',
  at: '2026-11-02T10:00:00.000Z',
  kind: 'passed',
  ...overrides,
});

const meta = {
  title: 'Components/QaComment',
  component: QaCommentView,
  args: { defaultOpen: true, ticketType: 'fix' },
} satisfies Meta<typeof QaCommentView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Passed: Story = { args: { comment: comment({}) } };
export const Gate1Failed: Story = {
  args: {
    comment: comment({
      kind: 'gate1Failed',
      failing: [{ name: 'notes are listed newest first', error: 'Expected 2026-03-01, got 2026-01-01' }],
    }),
  },
};
export const Gate2Failed: Story = {
  args: { comment: comment({ kind: 'gate2Failed', failing: [{ name: 'a note without a title shows Untitled' }] }) },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByTestId('qa-comment-text')).toHaveTextContent(
      'The reported bug is still unresolved.',
    );
  },
};
/** The same failed Gate 2 on an optimize ticket: there is no bug, there is a goal not reached. */
export const Gate2FailedOnAnOptimizeTicket: Story = {
  args: {
    ticketType: 'optimize',
    comment: comment({ kind: 'gate2Failed', failing: [{ name: 'the list endpoint runs at most 3 queries' }] }),
  },
  play: async ({ canvasElement }) => {
    const text = within(canvasElement).getByTestId('qa-comment-text');
    await expect(text).toHaveTextContent('The goal of the ticket is not reached yet.');
    await expect(text).not.toHaveTextContent(/bug/i);
  },
};
export const Gate2FailedOnABuildTicketInPortuguese: Story = {
  args: {
    ticketType: 'build',
    comment: comment({ kind: 'gate2Failed', failing: [{ name: 'the note page shows its tags' }] }),
  },
  globals: { locale: 'pt' },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByTestId('qa-comment-text')).toHaveTextContent(
      'O ticket ainda não foi entregue.',
    );
  },
};
/** Any other result reads the same whatever the ticket type. */
export const Gate1FailedOnABuildTicket: Story = {
  args: {
    ticketType: 'build',
    comment: comment({ kind: 'gate1Failed', failing: [{ name: 'notes are listed newest first' }] }),
  },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement).getByTestId('qa-comment-text')).toHaveTextContent(
      'Existing functionality broke.',
    );
  },
};
export const Timeout: Story = {
  args: { comment: comment({ kind: 'timeout', timeoutSeconds: 180, unfinished: ['the ticket test'] }) },
};
export const Interrupted: Story = { args: { comment: comment({ kind: 'interrupted' }) } };
export const InfrastructureError: Story = {
  args: { comment: comment({ kind: 'error', detail: 'docker: no space left on device' }) },
};
export const BranchWarning: Story = { args: { comment: comment({ kind: 'branchWarning', branch: 'my-experiment' }) } };
