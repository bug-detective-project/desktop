/**
 * What the e2e tests expect from the project they play (Smoke Desk), read from the folder in use (the local worktree or
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
import { projectQa } from './fixtures.ts';

const manifest = await buildManifest({ qaDir: projectQa, version: '0.0.0', runner: runCommand });
const { story } = projectContentOf(await readQaFiles(projectQa, runCommand));

/** A ticket's title as its ticket.<language>.md heading has it, like "SD-101: …". */
function ticketTitle(id: string, language: Language): string {
  const heading = readFileSync(join(projectQa, 'tickets', id, `ticket.${language}.md`), 'utf8').split('\n')[0];
  return heading.replace(/^#\s*/, '').trim();
}

export const smokedesk = {
  /** The ticket's key, like SD-101. */
  key: (id: string) => ticketTitle(id, 'en').split(': ')[0],
  title: ticketTitle,
  /** The first section heading of the ticket's text, like "Descrição". */
  ticketSection: (id: string, language: Language) =>
    readFileSync(join(projectQa, 'tickets', id, `ticket.${language}.md`), 'utf8')
      .split('\n')
      .find((line) => line.startsWith('## '))!
      .slice(3)
      .trim(),
  counts: countsOf(manifest),
  difficulty: manifest.project.difficulty,
  story: story as Record<Language, ProjectStory>,
  /** A hint of the ticket (1 to 3), as hints.<language>.json has it. */
  hint: (id: string, n: number, language: Language = 'en') =>
    (JSON.parse(readFileSync(join(projectQa, 'tickets', id, `hints.${language}.json`), 'utf8')) as { hints: string[] })
      .hints[n - 1]!,
  /** The first file the ticket's reference.patch changes (not one it adds), like client/src/api/audit.ts. */
  changedFile: (id: string) => {
    const patch = readFileSync(join(projectQa, 'tickets', id, 'reference.patch'), 'utf8');
    const file = patch
      .split(/^diff --git /m)
      .slice(1)
      .find((section) => !/^new file mode/m.test(section));
    return /^a\/(\S+)/.exec(file!)![1]!;
  },
  /** The subject of the e-mail that assigns a ticket. */
  assignment: (id: string, language: Language) => story[language].messages.assignments[id].subject,
};
