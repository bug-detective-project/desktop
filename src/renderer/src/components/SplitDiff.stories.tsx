import type { Meta, StoryObj } from '@storybook/react-vite';
import { reviewComparisonFixture } from '../storybook/fixtures.ts';
import { SplitDiff } from './SplitDiff.tsx';

const meta = {
  title: 'Components/SplitDiff',
  component: SplitDiff,
  args: { labels: { left: 'Your solution', right: 'Reference', onlyLeft: 'Only in your solution', onlyRight: 'Only in the reference' }, testId: 'split' },
} satisfies Meta<typeof SplitDiff>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Baseline: Story = { args: { diff: reviewComparisonFixture().baseline } };
export const Solutions: Story = { args: { diff: reviewComparisonFixture().solutionsIgnoringWhitespace } };
