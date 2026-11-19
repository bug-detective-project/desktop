import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { TICKET_TYPES } from '@shared/ticketMeta.ts';
import { TicketTypeBadge } from './TicketTypeBadge.tsx';

const meta = {
  title: 'Components/TicketTypeBadge',
  component: TicketTypeBadge,
  args: { type: 'fix', bothSides: false },
  decorators: [
    (Story) => (
      <div className="flex items-center gap-2">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof TicketTypeBadge>;
export default meta;
type Story = StoryObj<typeof meta>;

/** A ticket without a ticket.json: a fix ticket, with no both-sides mark. */
export const Fix: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('ticket-type')).toHaveAttribute('data-type', 'fix');
    await expect(canvas.getByTestId('ticket-type')).toHaveTextContent('Bug');
    await expect(canvas.queryByTestId('ticket-both-sides')).toBeNull();
  },
};
export const Build: Story = { args: { type: 'build' } };
export const Complete: Story = { args: { type: 'complete' } };
export const Refactor: Story = { args: { type: 'refactor' } };
export const Optimize: Story = { args: { type: 'optimize' } };
export const Upgrade: Story = { args: { type: 'upgrade' } };
export const Investigate: Story = { args: { type: 'investigate' } };
export const BothSides: Story = {
  args: { type: 'build', bothSides: true },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByTestId('ticket-type')).toHaveTextContent('Feature');
    await expect(canvas.getByTestId('ticket-both-sides')).toHaveTextContent('Front + back');
  },
};

/** Every type side by side, as on a board with tickets of each kind. */
export const AllTypes: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      {TICKET_TYPES.map((type) => (
        <TicketTypeBadge key={type} type={type} bothSides={type === 'optimize'} />
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const labels = within(canvasElement)
      .getAllByTestId('ticket-type')
      .map((tag) => tag.textContent);
    await expect(labels).toEqual(['Bug', 'Feature', 'Complete', 'Refactor', 'Optimize', 'Upgrade', 'Investigate']);
  },
};

/** Each type has a hue of its own: seven tags, seven text colors and seven backgrounds. */
export const OneHuePerType: Story = {
  ...AllTypes,
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      {TICKET_TYPES.map((type) => (
        <TicketTypeBadge key={type} type={type} bothSides={false} />
      ))}
    </div>
  ),
  play: async ({ canvasElement }) => {
    const tags = within(canvasElement).getAllByTestId('ticket-type');
    await expect(tags.map((tag) => tag.dataset.type)).toEqual([...TICKET_TYPES]);
    const styles = tags.map((tag) => getComputedStyle(tag));
    await expect(new Set(styles.map((style) => style.color)).size).toBe(TICKET_TYPES.length);
    await expect(new Set(styles.map((style) => style.backgroundColor)).size).toBe(TICKET_TYPES.length);
  },
};

/** The names in Portuguese: a fix ticket is a "Bug" and a build ticket a "Feature" there too. */
export const AllTypesInPortuguese: Story = {
  ...AllTypes,
  globals: { locale: 'pt' },
  play: async ({ canvasElement }) => {
    const labels = within(canvasElement)
      .getAllByTestId('ticket-type')
      .map((tag) => tag.textContent);
    await expect(labels).toEqual(['Bug', 'Feature', 'Completar', 'Refatorar', 'Otimizar', 'Atualizar', 'Investigar']);
  },
};
