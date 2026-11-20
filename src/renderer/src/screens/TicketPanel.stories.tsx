import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, within } from 'storybook/test';
import { snapshotFixture } from '../storybook/fixtures.ts';
import { TicketPanel } from './TicketPanel.tsx';

const meta = { title: 'Screens/TicketPanel', parameters: { layout: 'fullscreen' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const InProgress: Story = {
  render: () => (
    <TicketPanel snapshot={snapshotFixture('active')} ticketNumber={1} onClose={fn()} onOpenReview={fn()} />
  ),
  play: async ({ canvasElement }) => {
    await expect(await within(canvasElement.ownerDocument.body).findByTestId('ticket-markdown')).toBeVisible();
  },
};
export const InCodeReview: Story = {
  render: () => (
    <TicketPanel snapshot={snapshotFixture('review')} ticketNumber={1} onClose={fn()} onOpenReview={fn()} />
  ),
};
export const Portuguese: Story = { ...InProgress, globals: { locale: 'pt' } };

/** The header says the kind of work of the ticket, and the both-sides mark when it has one. */
export const TicketOfAnotherType: Story = {
  render: () => (
    <TicketPanel
      snapshot={snapshotFixture('active', { ticketMeta: { 1: { type: 'build', bothSides: true } } })}
      ticketNumber={1}
      onClose={fn()}
      onOpenReview={fn()}
    />
  ),
  play: async ({ canvasElement }) => {
    const panel = await within(canvasElement.ownerDocument.body).findByTestId('ticket-panel');
    const header = within(panel.querySelector('header')!);
    await expect(header.getByTestId('ticket-type')).toHaveAttribute('data-type', 'build');
    await expect(header.getByTestId('ticket-both-sides')).toBeVisible();
  },
};

/**
 * The "Issue type" row of the ticket shows the name and the hue of the ticket's type, like the tag
 * of the header, whatever the ticket's own file says there ("Story" in the fixture).
 */
export const IssueTypeOfABug: Story = {
  ...InProgress,
  play: async ({ canvasElement }) => {
    const panel = await within(canvasElement.ownerDocument.body).findByTestId('ticket-panel');
    const row = await within(panel).findByTestId('ticket-issue-type');
    await expect(row).toHaveAttribute('data-type', 'fix');
    await expect(row).toHaveTextContent('Bug');
    await expect(within(panel.querySelector('header')!).getByTestId('ticket-type')).toHaveTextContent('Bug');
  },
};
export const IssueTypeOfAFeature: Story = {
  ...TicketOfAnotherType,
  play: async ({ canvasElement }) => {
    const panel = await within(canvasElement.ownerDocument.body).findByTestId('ticket-panel');
    const row = await within(panel).findByTestId('ticket-issue-type');
    const tag = within(panel.querySelector('header')!).getByTestId('ticket-type');
    await expect(row).toHaveAttribute('data-type', 'build');
    await expect(row).toHaveTextContent('Feature');
    await expect(tag).toHaveTextContent('Feature');
    // The same hue in both places.
    await expect(getComputedStyle(row.firstElementChild!).color).toBe(getComputedStyle(tag).color);
  },
};
export const IssueTypeInPortuguese: Story = {
  render: () => (
    <TicketPanel
      snapshot={snapshotFixture('active', { ticketMeta: { 1: { type: 'complete', bothSides: false } } })}
      ticketNumber={1}
      onClose={fn()}
      onOpenReview={fn()}
    />
  ),
  globals: { locale: 'pt' },
  play: async ({ canvasElement }) => {
    const panel = await within(canvasElement.ownerDocument.body).findByTestId('ticket-panel');
    await expect(await within(panel).findByTestId('ticket-issue-type')).toHaveTextContent('Completar');
  },
};

const skills = {
  en: ['Building components', 'Routes and navigation'],
  pt: ['Criação de componentes', 'Criação de rotas e navegação'],
};
/** The review snapshot with its ticket in another column, and the skills the main process sent for it (none unless Done). */
const withTicket = (status: 'inProgress' | 'codeReview' | 'done', practiced: Record<number, typeof skills>) => {
  const snapshot = snapshotFixture('review', { practiced });
  snapshot.state.tickets[0].status = status;
  return snapshot;
};

/** A Done ticket says what it trained. */
export const DoneWithPracticedSkills: Story = {
  render: () => (
    <TicketPanel snapshot={withTicket('done', { 1: skills })} ticketNumber={1} onClose={fn()} onOpenReview={fn()} />
  ),
  play: async ({ canvasElement }) => {
    const practiced = await within(canvasElement.ownerDocument.body).findByTestId('ticket-practiced');
    await expect(practiced).toHaveTextContent('You practiced');
    await expect(
      within(practiced)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(skills.en);
  },
};
export const DoneWithPracticedSkillsInPortuguese: Story = {
  ...DoneWithPracticedSkills,
  globals: { locale: 'pt' },
  play: async ({ canvasElement }) => {
    const practiced = await within(canvasElement.ownerDocument.body).findByTestId('ticket-practiced');
    await expect(practiced).toHaveTextContent('Você praticou');
    await expect(
      within(practiced)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(skills.pt);
  },
};

/** A Done ticket that names no skills shows nothing. */
export const DoneWithoutSkills: Story = {
  render: () => <TicketPanel snapshot={withTicket('done', {})} ticketNumber={1} onClose={fn()} onOpenReview={fn()} />,
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await body.findByTestId('ticket-panel');
    await expect(body.queryByTestId('ticket-practiced')).toBeNull();
  },
};

/** The skills hint at the cause: a ticket that is not Done never shows them, whatever the snapshot holds. */
export const NotDoneNeverShowsSkills: Story = {
  render: () => (
    <TicketPanel
      snapshot={withTicket('codeReview', { 1: skills })}
      ticketNumber={1}
      onClose={fn()}
      onOpenReview={fn()}
    />
  ),
  play: async ({ canvasElement }) => {
    const body = within(canvasElement.ownerDocument.body);
    await body.findByTestId('ticket-panel');
    await expect(body.queryByTestId('ticket-practiced')).toBeNull();
  },
};

/** A skill may be 60 characters long: the tag wraps inside the header instead of widening the panel. */
export const DoneWithALongSkill: Story = {
  render: () => {
    const long = {
      en: ['Tracing a request across services and message queues, end to'],
      pt: ['Rastrear uma requisição entre serviços e filas de mensagens'],
    };
    return (
      <TicketPanel snapshot={withTicket('done', { 1: long })} ticketNumber={1} onClose={fn()} onOpenReview={fn()} />
    );
  },
  play: async ({ canvasElement }) => {
    const practiced = await within(canvasElement.ownerDocument.body).findByTestId('ticket-practiced');
    await expect(within(practiced).getByRole('listitem').textContent).toHaveLength(60);
    await expect(practiced.scrollWidth).toBeLessThanOrEqual(practiced.clientWidth);
  },
};
