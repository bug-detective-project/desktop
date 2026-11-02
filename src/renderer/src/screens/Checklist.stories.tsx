import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { snapshotFixture } from '../storybook/fixtures.ts';
import { Checklist, DockerBanner } from './Checklist.tsx';

const meta = { title: 'Screens/Checklist', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const EverythingReady: Story = { render: () => <Checklist snapshot={snapshotFixture('queued')} onContinue={fn()} /> };

/** Docker stopped and the Dev Containers extension missing: their actions show, and the player cannot start. */
export const SomethingMissing: Story = {
  render: () => {
    const snapshot = snapshotFixture('queued');
    const prerequisites = snapshot.prerequisites!;
    prerequisites.allOk = false;
    prerequisites.dockerState = 'notRunning';
    prerequisites.checks = prerequisites.checks.map((check) => (check.id === 'docker' ? { ...check, status: 'missing' } : check.id === 'devcontainers' ? { ...check, status: 'missing' } : check));
    return <Checklist snapshot={{ ...snapshot, dockerState: 'notRunning', prerequisites }} onContinue={fn()} />;
  },
};

export const DockerStoppedBanner: Story = { render: () => <DockerBanner snapshot={snapshotFixture('active', { dockerState: 'notRunning' })} /> };
