import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, within } from 'storybook/test';
import { InstallModal } from './InstallModal.tsx';

const lines = ['» docker build bugdetective-workspace', 'Step 1/8 : FROM node:26.12.1-bookworm', '» docker build bugdetective-qa'];

const meta = { title: 'Components/InstallModal', component: InstallModal, args: { lines, error: null, onClose: fn(), onRetry: null } } satisfies Meta<typeof InstallModal>;
export default meta;
type Story = StoryObj<typeof meta>;

/** No internet: the same download is worth repeating, so "Try again" shows next to the log. */
export const FailedNoConnection: Story = {
  args: { phase: 'failed', error: 'No internet connection. Connect and try again.', onRetry: fn() },
  play: async ({ args, canvasElement }) => {
    const modal = within(canvasElement.ownerDocument.body);
    await userEvent.click(modal.getByTestId('install-modal-retry'));
    await expect(args.onRetry).toHaveBeenCalledTimes(1);
  },
};

/** While it runs it cannot be closed. */
export const Running: Story = {
  args: { phase: 'running' },
  play: async ({ canvasElement }) => {
    const modal = within(canvasElement.ownerDocument.body);
    await expect(modal.queryByRole('button', { name: 'Close' })).toBeNull();
  },
};

export const Done: Story = {
  args: { phase: 'done' },
  play: async ({ args, canvasElement }) => {
    // Success is a notice like the error, in its own (success) tone.
    const status = within(canvasElement.ownerDocument.body).getByTestId('install-modal-status');
    await expect(status).toHaveAttribute('data-tone', 'success');
    await expect(status).toHaveTextContent('Everything is ready.');
    await userEvent.click(within(canvasElement.ownerDocument.body).getByRole('button', { name: 'Close' }));
    await expect(args.onClose).toHaveBeenCalled();
  },
};

export const Failed: Story = {
  args: { phase: 'failed', error: 'Something went wrong: docker build failed: no space left on device' },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement.ownerDocument.body).getByTestId('install-modal-error')).toHaveAttribute('data-tone', 'danger');
  },
};
/** Less than 10 GB free on the Docker disk: a warning, and the player chooses to continue or cancel. */
export const LowDiskSpace: Story = {
  args: { phase: 'lowDisk', lines: [], lowDisk: { freeBytes: 1_200_000_000, neededBytes: 10e9 }, onContinueAnyway: fn() },
  play: async ({ args, canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await expect(body.getByTestId('install-modal-low-disk')).toHaveTextContent('About 10 GB are needed on the Docker disk; you have 1.2 GB free.');
    await userEvent.click(body.getByRole('button', { name: 'Continue anyway' }));
    await expect(args.onContinueAnyway).toHaveBeenCalled();
    await userEvent.click(body.getByRole('button', { name: 'Cancel' }));
    await expect(args.onClose).toHaveBeenCalled();
  },
};
export const LowDiskSpaceInPortuguese: Story = { args: LowDiskSpace.args, globals: { locale: 'pt' } };
export const FailedInPortuguese: Story = { ...Failed, globals: { locale: 'pt' } };
export const TicketRunning: Story = { args: { kind: 'ticket', phase: 'running', lines: ['» Fetching front-1 from the local qa folder', '» Verified front-1 (42 files and the ticket package, SHA-256)'] } };
export const TicketFailed: Story = { args: { kind: 'ticket', phase: 'failed', lines: ['» Fetching front-1 from GitHub'], error: 'No internet connection. Connect and try again.' } };
export const TicketFailedInPortuguese: Story = { ...TicketFailed, globals: { locale: 'pt' } };
