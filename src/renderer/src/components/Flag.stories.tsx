import type { Meta, StoryObj } from '@storybook/react-vite';
import { Flag } from './Flag.tsx';

const meta = { title: 'Components/Flag', component: Flag } satisfies Meta<typeof Flag>;
export default meta;
type Story = StoryObj<typeof meta>;
export const English: Story = { args: { language: 'en' } };
export const Portuguese: Story = { args: { language: 'pt' } };
