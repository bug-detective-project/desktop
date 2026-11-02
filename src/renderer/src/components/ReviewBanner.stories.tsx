import type { Meta, StoryObj } from '@storybook/react-vite';
import { snapshotFixture } from '../storybook/fixtures.ts';
import { ReviewBanner } from './ReviewBanner.tsx';

const session = { ticket: 1, phase: 'open' as const, startedAt: '2026-11-02T10:00:00.000Z', returnPoint: { branch: 'player/ticket-1', head: 'a'.repeat(40), indexTree: 'b'.repeat(40), excludesFile: null }, wipCommit: null };

const meta = { title: 'Components/ReviewBanner' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const ReviewOpen: Story = { render: () => <ReviewBanner snapshot={snapshotFixture('review', { state: { reviewSession: session } })} /> };
export const EditsSaved: Story = { render: () => <ReviewBanner snapshot={snapshotFixture('review', { reviewNotice: { ticket: 1, kind: 'editsSaved' } })} /> };
