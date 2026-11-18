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

const numbered = (count: number) => ({
  en: Array.from({ length: count }, (_, index) => `Skill number ${index + 1}`),
  pt: Array.from({ length: count }, (_, index) => `Habilidade número ${index + 1}`),
});
const openBrief = async (canvasElement: HTMLElement) => {
  const canvas = within(canvasElement);
  await userEvent.click(canvas.getByTestId('project-notes-brief'));
  await waitFor(() => expect(canvas.getByTestId('project-notes-close-brief')).toHaveFocus());
  return canvas;
};

/** A project may list up to 12 skills: the brief shows the first 5 and opens the rest on request. */
export const BriefWithTwelveSkills: Story = {
  render: card({ details: { ...details, skills: numbered(12) } }),
  play: async ({ canvasElement }) => {
    const canvas = await openBrief(canvasElement);
    const shown = () => within(canvas.getByTestId('project-skills')).getAllByRole('listitem');
    await expect(shown()).toHaveLength(5);
    await expect(shown()[4]).toHaveTextContent('Skill number 5');
    const all = canvas.getByTestId('project-skills-all');
    await expect(all).toHaveTextContent('See all (12)');
    await expect(all).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(all);
    await expect(shown()).toHaveLength(12);
    await expect(shown()[11]).toHaveTextContent('Skill number 12');
    await expect(canvas.getByTestId('project-skills-all')).toHaveTextContent('Show fewer');
    await expect(canvas.getByTestId('project-skills-all')).toHaveAttribute('aria-expanded', 'true');

    await userEvent.click(canvas.getByTestId('project-skills-all'));
    await expect(shown()).toHaveLength(5);
  },
};

/** With 5 skills or fewer there is nothing more to open. */
export const BriefWithFiveSkills: Story = {
  render: card({ details: { ...details, skills: numbered(5) } }),
  play: async ({ canvasElement }) => {
    const canvas = await openBrief(canvasElement);
    await expect(within(canvas.getByTestId('project-skills')).getAllByRole('listitem')).toHaveLength(5);
    await expect(canvas.queryByTestId('project-skills-all')).toBeNull();
  },
};

export const BriefWithoutSkills: Story = {
  render: card({ details: { ...details, skills: { en: [], pt: [] } } }),
  play: async ({ canvasElement }) => {
    const canvas = await openBrief(canvasElement);
    await expect(canvas.queryByTestId('project-skills')).toBeNull();
    await expect(canvas.queryByTestId('project-skills-all')).toBeNull();
  },
};

/** A skill may be 60 characters long: it wraps inside the card instead of pushing it wider. */
export const BriefWithALongSkill: Story = {
  render: card({ details: { ...details, skills: { en: ['Tracing a request across services and message queues, end to end'.slice(0, 60)], pt: ['Rastrear uma requisição entre serviços e filas de mensagens, de ponta'.slice(0, 60)] } } }),
  play: async ({ canvasElement }) => {
    const canvas = await openBrief(canvasElement);
    const list = canvas.getByTestId('project-skills');
    await expect(list.scrollWidth).toBeLessThanOrEqual(list.clientWidth);
  },
};
export const BriefWithTwelveSkillsInPortuguese: Story = {
  render: card({ details: { ...details, skills: numbered(12) } }),
  globals: { locale: 'pt' },
  play: async ({ canvasElement }) => {
    const canvas = await openBrief(canvasElement);
    await expect(canvas.getByTestId('project-skills-all')).toHaveTextContent('Ver todas (12)');
  },
};

/** A project with services says how much memory it needs at its peak; one without says nothing. */
export const MemoryRequirement: Story = {
  render: card({ details: { ...details, memoryBytes: 5.5 * 1024 ** 3 } }),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTestId('project-notes-brief'));
    await expect(canvas.getByTestId('project-memory')).toHaveTextContent('Memory');
    await expect(canvas.getByTestId('project-memory')).toHaveTextContent('5.5 GB');
  },
};
export const NoMemoryRequirement: Story = {
  render: card(),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByTestId('project-notes-brief'));
    await expect(canvas.queryByTestId('project-memory')).toBeNull();
  },
};
