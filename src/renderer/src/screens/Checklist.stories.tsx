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

/** Docker Desktop switched to Windows containers: Docker fails with its own help link, and the player cannot start. */
export const WindowsContainers: Story = {
  render: () => {
    const snapshot = snapshotFixture('queued');
    const prerequisites = snapshot.prerequisites!;
    prerequisites.allOk = false;
    prerequisites.checks = prerequisites.checks.map((check) => (check.id === 'docker' ? { ...check, status: 'missing', reason: 'windowsContainers' } : check));
    return <Checklist snapshot={{ ...snapshot, prerequisites }} onContinue={fn()} />;
  },
};

/** The engine has little memory: Docker passes with a warning and its .wslconfig link; the player can start. */
export const LowMemory: Story = {
  render: () => {
    const snapshot = snapshotFixture('queued');
    const prerequisites = snapshot.prerequisites!;
    prerequisites.checks = prerequisites.checks.map((check) => (check.id === 'docker' ? { ...check, warnings: ['lowMemory'] } : check));
    return <Checklist snapshot={{ ...snapshot, prerequisites }} onContinue={fn()} />;
  },
};
export const LowMemoryInPortuguese: Story = { ...LowMemory, globals: { locale: 'pt' } };

/** An SSH agent and a stored GitHub credential on the computer: VS Code passes with two warnings and a link to what the app does; the player can start. */
export const CredentialWarnings: Story = {
  render: () => {
    const snapshot = snapshotFixture('queued');
    const prerequisites = snapshot.prerequisites!;
    prerequisites.checks = prerequisites.checks.map((check) => (check.id === 'vscode' ? { ...check, warnings: ['sshAgent', 'githubCredential'] } : check));
    return <Checklist snapshot={{ ...snapshot, prerequisites }} onContinue={fn()} />;
  },
};
export const CredentialWarningsInPortuguese: Story = { ...CredentialWarnings, globals: { locale: 'pt' } };

export const DockerStoppedBanner: Story = { render: () => <DockerBanner snapshot={snapshotFixture('active', { dockerState: 'notRunning' })} /> };
