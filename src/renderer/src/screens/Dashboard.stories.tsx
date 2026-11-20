import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import type { Snapshot } from '@shared/api.ts';
import { snapshotFixture } from '../storybook/fixtures.ts';
import { Dashboard } from './Dashboard.tsx';

/** The Dashboard in each state of the work desk. */
const meta = { title: 'Screens/Dashboard', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const show = (snapshot: () => Snapshot) => () => (
  <Dashboard snapshot={snapshot()} onOpenBoard={fn()} onOpenTicket={fn()} onOpenReview={fn()} onOpenSettings={fn()} />
);

export const NextAssignmentQueued: Story = { render: show(() => snapshotFixture('queued')) };
export const DownloadNeeded: Story = {
  render: show(() =>
    snapshotFixture('queued', {
      environment: {
        items: [
          { id: 'workspaceImage', ready: false },
          { id: 'qaImage', ready: false },
        ],
        ready: false,
      },
    }),
  ),
};
export const UnlockingTicket: Story = {
  render: show(() =>
    snapshotFixture('queued', { busy: 'unlocking', log: ['» Fetching front-1', '» Verified front-1'] }),
  ),
};
export const TicketInProgress: Story = { render: show(() => snapshotFixture('active')) };
export const TicketInCodeReview: Story = { render: show(() => snapshotFixture('review')) };
export const DockerStopped: Story = { render: show(() => snapshotFixture('queued', { dockerState: 'notRunning' })) };
export const DatabaseResetFailed: Story = { render: show(() => snapshotFixture('active', { dbResetFailed: true })) };
/** A project with services: each one is a row with its state as a word, and Docker's own reason when it stopped. */
export const ProjectServices: Story = {
  render: show(() =>
    snapshotFixture('active', {
      services: [
        { name: 'db', image: 'postgres:17', state: 'ready' },
        { name: 'audit', image: 'postgres:17', state: 'failed', reason: 'Error: superuser password is not specified.' },
        { name: 'cache', image: 'postgres:17', state: 'oom' },
      ],
    }),
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('env-service-db')).toHaveTextContent('db · postgres:17');
    await expect(canvas.getByTestId('env-service-db')).toHaveTextContent('Ready');
    await expect(canvas.getByTestId('env-service-db')).toHaveAttribute('data-tone', 'ok');
    await expect(canvas.getByTestId('env-service-audit')).toHaveTextContent(
      'Stopped: Error: superuser password is not specified.',
    );
    await expect(canvas.getByTestId('env-service-audit')).toHaveAttribute('data-tone', 'danger');
    await expect(canvas.getByTestId('env-service-cache')).toHaveTextContent('Stopped: out of memory');
  },
};
/** A stopped service offers "Recreate services", which says first what is erased and what stays. */
const recreateServices = fn(async () => {});
export const RecreateServices: Story = {
  ...ProjectServices,
  parameters: { api: { recreateServices } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getAllByTestId('recreate-services')).toHaveLength(1);
    await expect(canvas.getByTestId('services-out-of-memory')).toHaveTextContent("Increase Docker's memory");
    await userEvent.click(canvas.getByTestId('recreate-services'));
    const dialog = within(canvasElement.ownerDocument.body);
    await expect(dialog.getByTestId('recreate-services-warning')).toHaveTextContent(
      'Your code and your progress stay.',
    );
    await expect(recreateServices).not.toHaveBeenCalled();
    await userEvent.click(dialog.getByTestId('recreate-services-confirm'));
    await expect(recreateServices).toHaveBeenCalledTimes(1);
  },
};
/** The workspace was killed for lack of memory: said once, with what to do, until the player closes it. */
export const WorkspaceOutOfMemory: Story = {
  render: show(() => snapshotFixture('active', { workspaceOutOfMemoryAt: '2026-11-17T12:00:00.000Z' })),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('workspace-out-of-memory')).toHaveTextContent("increase Docker's memory");
    await userEvent.click(canvas.getByTestId('workspace-out-of-memory-dismiss'));
    await expect(canvas.queryByTestId('workspace-out-of-memory')).toBeNull();
  },
};
export const ProjectServicesInPortuguese: Story = {
  ...ProjectServices,
  globals: { locale: 'pt' },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('env-service-db')).toHaveTextContent('Pronto');
    await expect(canvas.getByTestId('env-service-cache')).toHaveTextContent('Parado: faltou memória');
  },
};
export const WorkspaceInternetOn: Story = {
  render: show(() => snapshotFixture('active', { workspaceInternet: true })),
};
export const WorkspaceInternetOnInPortuguese: Story = { ...WorkspaceInternetOn, globals: { locale: 'pt' } };
/** Opening asks first: the warning says what else the project's code reaches. */
export const WorkspaceInternetDialog: Story = {
  render: show(() => snapshotFixture('active')),
  play: async ({ canvasElement }) => {
    await userEvent.click(within(canvasElement).getByTestId('workspace-internet-toggle'));
    await expect(within(canvasElement.ownerDocument.body).getByTestId('workspace-internet-warning')).toHaveTextContent(
      'your local network',
    );
  },
};
export const WorkspaceLost: Story = { render: show(() => snapshotFixture('active', { workspaceLost: true })) };
export const WorkspaceRecreating: Story = {
  render: show(() =>
    snapshotFixture('active', {
      workspaceLost: true,
      busy: 'rebuilding',
      log: ['» Fetching front-1', '» Recreated the code of ticket 1 (front-1)'],
    }),
  ),
};
export const Portuguese: Story = { render: show(() => snapshotFixture('active')), globals: { locale: 'pt' } };
