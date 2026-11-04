import type { Meta, StoryObj } from '@storybook/react-vite'
import { fn } from 'storybook/test'
import { WorkspaceLostNotice } from './WorkspaceLostNotice.tsx'

const meta: Meta<typeof WorkspaceLostNotice> = { component: WorkspaceLostNotice, args: { onRebuild: fn(), onRestore: fn() } }
export default meta
type Story = StoryObj<typeof WorkspaceLostNotice>

export const Lost: Story = { args: { busy: false } }
export const Recreating: Story = { args: { busy: true } }
