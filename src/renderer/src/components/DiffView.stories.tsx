import type { Meta, StoryObj } from '@storybook/react-vite';
import { reviewComparisonFixture } from '../storybook/fixtures.ts';
import { DiffView } from './DiffView.tsx';

const meta = { title: 'Components/DiffView', component: DiffView } satisfies Meta<typeof DiffView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const WithChanges: Story = { args: { diff: reviewComparisonFixture().baseline } };
export const Empty: Story = { args: { diff: null, emptyText: 'No changes yet.' } };
