import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import type { Snapshot } from '@shared/api.ts';
import { snapshotFixture } from '../storybook/fixtures.ts';
import { Dashboard } from './Dashboard.tsx';

/** The Dashboard in each state of the work desk. */
const meta = { title: 'Screens/Dashboard', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const show = (snapshot: () => Snapshot) => () => <Dashboard snapshot={snapshot()} onOpenBoard={fn()} onOpenTicket={fn()} onOpenReview={fn()} onOpenSettings={fn()} />;

export const NextAssignmentQueued: Story = { render: show(() => snapshotFixture('queued')) };
export const DownloadNeeded: Story = {
  render: show(() => snapshotFixture('queued', { environment: { items: [{ id: 'workspaceImage', ready: false }, { id: 'qaImage', ready: false }], ready: false } })),
};
export const UnlockingTicket: Story = { render: show(() => snapshotFixture('queued', { busy: 'unlocking', log: ['» Fetching front-1', '» Verified front-1'] })) };
export const TicketInProgress: Story = { render: show(() => snapshotFixture('active')) };
export const TicketInCodeReview: Story = { render: show(() => snapshotFixture('review')) };
export const DockerStopped: Story = { render: show(() => snapshotFixture('queued', { dockerState: 'notRunning' })) };
export const DatabaseResetFailed: Story = { render: show(() => snapshotFixture('active', { dbResetFailed: true })) };
export const WorkspaceLost: Story = { render: show(() => snapshotFixture('active', { workspaceLost: true })) };
export const WorkspaceRecreating: Story = { render: show(() => snapshotFixture('active', { workspaceLost: true, busy: 'rebuilding', log: ['» Fetching front-1', '» Recreated the code of ticket 1 (front-1)'] })) };
export const Dark: Story = { render: show(() => snapshotFixture('active')), globals: { theme: 'dark' } };
export const Portuguese: Story = { render: show(() => snapshotFixture('active')), globals: { locale: 'pt' } };
