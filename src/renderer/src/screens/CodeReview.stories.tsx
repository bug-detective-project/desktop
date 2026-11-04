import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { snapshotFixture } from '../storybook/fixtures.ts';
import { CodeReview } from './CodeReview.tsx';

const meta = { title: 'Screens/CodeReview', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
export const Comparison: Story = { render: () => <CodeReview snapshot={snapshotFixture('review')} ticketNumber={1} onBack={fn()} /> };
