import type { Meta, StoryObj } from '@storybook/react-vite';
import { ErrorBoundary } from './ErrorBoundary.tsx';

function Broken(): never {
  throw new Error("Cannot read properties of undefined (reading 'ticket')");
}

const meta: Meta<typeof ErrorBoundary> = {
  component: ErrorBoundary,
  parameters: { layout: 'fullscreen' },
  render: () => (
    <ErrorBoundary>
      <Broken />
    </ErrorBoundary>
  ),
};
export default meta;
type Story = StoryObj<typeof ErrorBoundary>;

export const RenderError: Story = {};
export const Portuguese: Story = { globals: { locale: 'pt' } };
