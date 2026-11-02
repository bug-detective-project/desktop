import type { Meta, StoryObj } from '@storybook/react-vite';
import { useState } from 'react';
import { expect, within } from 'storybook/test';
import { Icon } from './icons.tsx';
import { Badge, Button, Card, LogView, Modal, Notice, SectionTitle, Spinner, StagePill, StatusIcon, Tabs, Tooltip, TrackBadge } from './ui.tsx';

/** The building blocks of components/ui.tsx, side by side. */
const meta = { title: 'Components/UI', parameters: { layout: 'padded' } } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Buttons: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      {(['primary', 'secondary', 'card', 'ghost', 'danger', 'dangerOutline', 'review'] as const).map((variant) => (
        <Button key={variant} variant={variant}>
          {variant}
        </Button>
      ))}
      <Button size="sm">Small</Button>
      <Button size="xs">Extra small</Button>
      <Button variant="primary" busy>
        Busy
      </Button>
      <Button disabled>Disabled</Button>
      <Button variant="primary">
        <Icon name="arrowRight" />
        With an icon
      </Button>
    </div>
  ),
};

export const BadgesAndStages: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-3">
      {(['neutral', 'ok', 'warn', 'danger', 'brand'] as const).map((tone) => (
        <Badge key={tone} tone={tone}>
          {tone}
        </Badge>
      ))}
      <TrackBadge track="front" />
      <TrackBadge track="back" />
      {(['todo', 'inProgress', 'inQa', 'codeReview', 'done'] as const).map((status) => (
        <StagePill key={status} status={status} />
      ))}
      <StagePill status="todo" dot />
      {(['ok', 'missing', 'pending', 'warning'] as const).map((status) => (
        <StatusIcon key={status} status={status} />
      ))}
      <Spinner />
    </div>
  ),
};

export const Notices: Story = {
  render: () => (
    <div className="max-w-lg space-y-3">
      <Notice>A warning that needs attention.</Notice>
      <Notice tone="danger">Something failed, and this is why.</Notice>
      <Notice tone="success">Everything is ready.</Notice>
    </div>
  ),
};

export const CardWithTitle: Story = {
  render: () => (
    <Card className="max-w-md p-5">
      <SectionTitle aside={<Badge tone="ok">Ready</Badge>}>Section title</SectionTitle>
      <p className="mt-2 text-muted-foreground">Card content.</p>
    </Card>
  ),
};

export const TooltipOnHover: Story = {
  render: () => (
    <Tooltip content="The full label">
      <Button>Hover me</Button>
    </Tooltip>
  ),
};

function TabsExample() {
  const [active, setActive] = useState<'ticket' | 'qa'>('ticket');
  return (
    <Tabs
      tabs={[
        { id: 'ticket', label: 'Ticket' },
        { id: 'qa', label: 'QA', badge: <Badge tone="danger">1</Badge> },
      ]}
      active={active}
      onChange={setActive}
    />
  );
}

export const TabsBar: Story = { render: () => <TabsExample /> };

export const Log: Story = {
  render: () => <LogView lines={['» docker build bugdetective-workspace', 'Step 1/8 : FROM node:26', '» docker build bugdetective-qa']} />,
};

export const DialogNormal: Story = {
  render: () => (
    <Modal title="Restore progress?" onClose={() => {}}>
      <p>The progress in this file replaces the current one.</p>
    </Modal>
  ),
};

/** The close button is named in the app's language. */
export const DialogInPortuguese: Story = {
  ...DialogNormal,
  globals: { locale: 'pt' },
  play: async ({ canvasElement }) => {
    await expect(within(canvasElement.ownerDocument.body).getByRole('button', { name: 'Fechar' })).toBeVisible();
  },
};

export const DialogWithoutClose: Story = {
  render: () => (
    <Modal title="Restoring">
      <LogView lines={['» Restoring the workspace']} />
    </Modal>
  ),
};

export const DialogLarge: Story = {
  render: () => (
    <Modal title="Downloading the game environment" size="large">
      <LogView lines={Array.from({ length: 40 }, (_, line) => `» line ${line + 1}`)} className="min-h-0 flex-1" />
    </Modal>
  ),
};
