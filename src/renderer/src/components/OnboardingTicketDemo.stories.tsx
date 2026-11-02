import type { Meta, StoryObj } from '@storybook/react-vite';
import { OnboardingTicketDemo } from './OnboardingTicketDemo.tsx';

const meta = { title: 'Components/OnboardingTicketDemo', component: OnboardingTicketDemo } satisfies Meta<typeof OnboardingTicketDemo>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Ticket: Story = { args: { tab: 'ticket' } };
export const Qa: Story = { args: { tab: 'qa' } };
export const History: Story = { args: { tab: 'history' } };
export const Senior: Story = { args: { tab: 'senior' } };
