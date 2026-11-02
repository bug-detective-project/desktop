/**
 * What the e2e tests expect from SupportDesk, read from the folder in use (the local worktree or
 * the pinned publication, see global-setup.ts), so the tests hold for either. Texts of the app
 * itself (buttons, hints, Rafaela and Priya) stay written in the tests.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { countsOf, projectContentOf } from '@bug-detective/catalog/contract';
import type { ProjectStory } from '@bug-detective/catalog/contract';
import { buildManifest, readQaFiles } from '../../src/main/services/content/local-manifest.ts';
import { runCommand } from '../../src/main/services/process.ts';
import type { Language } from '../../src/shared/types.ts';
import { supportdeskQa } from './fixtures.ts';

const manifest = await buildManifest({ qaDir: supportdeskQa, version: '0.0.0', runner: runCommand });
const { story } = projectContentOf(await readQaFiles(supportdeskQa, runCommand));

/** A ticket's title as its ticket.<language>.md heading has it, like "SD-214: …". */
function ticketTitle(id: string, language: Language): string {
  const heading = readFileSync(join(supportdeskQa, 'tickets', id, `ticket.${language}.md`), 'utf8').split('\n')[0];
  return heading.replace(/^#\s*/, '').trim();
}

export const supportdesk = {
  /** The ticket's key, like SD-214. */
  key: (id: string) => ticketTitle(id, 'en').split(': ')[0],
  title: ticketTitle,
  /** The first section heading of the ticket's text, like "Descrição". */
  ticketSection: (id: string, language: Language) =>
    readFileSync(join(supportdeskQa, 'tickets', id, `ticket.${language}.md`), 'utf8')
      .split('\n')
      .find((line) => line.startsWith('## '))!
      .slice(3)
      .trim(),
  counts: countsOf(manifest),
  difficulty: manifest.project.difficulty,
  story: story as Record<Language, ProjectStory>,
  /** The subject of the e-mail that assigns a ticket. */
  assignment: (id: string, language: Language) => story[language].messages.assignments[id].subject,
};
