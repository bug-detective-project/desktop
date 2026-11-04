import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, fn, userEvent, waitFor, within } from 'storybook/test';
import type { ProjectCard } from '@shared/api.ts';
import { projectCardFixture } from '../storybook/fixtures.ts';
import i18n from '../i18n.ts';
import { ProjectFlipCard } from './ProjectFlipCard.tsx';

const meta = { title: 'Screens/ProjectFlipCard' } satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

const card = (overrides: Partial<ProjectCard> = {}) => () => (
  <div className="w-[450px]">
    <ProjectFlipCard card={projectCardFixture(overrides)} language={i18n.language === 'pt' ? 'pt' : 'en'} blocked={null} onPlay={fn()} />
  </div>
);
const details = projectCardFixture().details!;

export const Front: Story = { render: card() };
export const CurrentProject: Story = { render: card({ active: true, progress: { front: { done: 1, total: 2 }, back: { done: 0, total: 1 } } }) };
export const Intermediate: Story = { render: card({ details: { ...details, difficulty: 'intermediate' } }) };
export const Advanced: Story = { render: card({ details: { ...details, difficulty: 'advanced' } }) };
export const WithoutDetails: Story = { render: card({ details: null }) };
export const NeedsNewerApp: Story = { render: card({ unavailable: 'appTooOld' }) };
export const Unavailable: Story = { render: card({ unavailable: 'projectUnavailable' }) };

/** "View specifications" flips to the brief and moves the focus to the button that flips back. */
export const Brief: Story = {
  render: card(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTestId('project-notes-brief'));
    // The back stops being inert first; the focus moves on the next frame.
    await waitFor(() => expect(canvas.getByTestId('project-notes-close-brief')).toHaveFocus());
    await expect(canvas.getByTestId('project-notes-front')).toHaveAttribute('aria-hidden', 'true');
  },
};
export const BriefInPortuguese: Story = { ...Brief, globals: { locale: 'pt' } };
