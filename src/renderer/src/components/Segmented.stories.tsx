import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';
import { Segmented } from './Segmented.tsx';

type Option = 'system' | 'light' | 'dark';

function Example() {
  const [value, setValue] = useState<Option>('system');
  return (
    <Segmented<Option>
      label="Theme"
      value={value}
      options={[
        { value: 'system', icon: null, text: 'System' },
        { value: 'light', icon: null, text: 'Light' },
        { value: 'dark', icon: null, text: 'Dark' },
      ]}
      onChange={setValue}
      testId="theme"
    />
  );
}

const meta = { title: 'Components/Segmented', component: Example } satisfies Meta<typeof Example>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};


/** Tab reaches the selected option; the arrow keys move to the next one and select it. */
export const KeyboardNavigation: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(canvas.getByRole('radio', { name: 'System' })).toHaveFocus();
    await userEvent.keyboard('{ArrowRight}');
    await expect(canvas.getByRole('radio', { name: 'Light' })).toHaveFocus();
    await expect(canvas.getByRole('radio', { name: 'Light' })).toHaveAttribute('aria-checked', 'true');
    await userEvent.keyboard('{ArrowLeft}{ArrowLeft}');
    await expect(canvas.getByRole('radio', { name: 'Dark' })).toHaveAttribute('aria-checked', 'true');
  },
};
