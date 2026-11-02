import type { Meta, StoryObj } from '@storybook/react-vite';
import { fn } from 'storybook/test';
import { ContentError } from './ContentError.tsx';

const meta = { title: 'Components/ContentError', component: ContentError, args: { onRetry: fn() } } satisfies Meta<typeof ContentError>;
export default meta;
export const Default: StoryObj<typeof meta> = {};
