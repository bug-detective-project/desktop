import type { Meta, StoryObj } from '@storybook/react-vite';
import { CatalogWarning } from './CatalogWarning.tsx';

const meta: Meta<typeof CatalogWarning> = { component: CatalogWarning };
export default meta;
type Story = StoryObj<typeof CatalogWarning>;

export const Outdated: Story = {};
export const Portuguese: Story = { globals: { locale: 'pt' } };
