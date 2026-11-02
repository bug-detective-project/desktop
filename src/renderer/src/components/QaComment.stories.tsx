import type { Meta, StoryObj } from '@storybook/react-vite';
import type { QaComment } from '@shared/types.ts';
import { QaCommentView } from './QaComment.tsx';

const comment = (overrides: Partial<QaComment>): QaComment => ({ id: 'c1', at: '2026-11-02T10:00:00.000Z', kind: 'passed', ...overrides });

const meta = { title: 'Components/QaComment', component: QaCommentView, args: { defaultOpen: true } } satisfies Meta<typeof QaCommentView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Passed: Story = { args: { comment: comment({}) } };
export const Gate1Failed: Story = { args: { comment: comment({ kind: 'gate1Failed', failing: [{ name: 'notes are listed newest first', error: 'Expected 2026-03-01, got 2026-01-01' }] }) } };
export const Gate2Failed: Story = { args: { comment: comment({ kind: 'gate2Failed', failing: [{ name: 'a note without a title shows Untitled' }] }) } };
export const Timeout: Story = { args: { comment: comment({ kind: 'timeout', timeoutSeconds: 180, unfinished: ['the ticket test'] }) } };
export const Interrupted: Story = { args: { comment: comment({ kind: 'interrupted' }) } };
export const InfrastructureError: Story = { args: { comment: comment({ kind: 'error', detail: 'docker: no space left on device' }) } };
export const BranchWarning: Story = { args: { comment: comment({ kind: 'branchWarning', branch: 'my-experiment' }) } };
