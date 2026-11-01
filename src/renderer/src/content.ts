import type { ProjectStory } from '@shared/api.ts';
import type { Language } from '@shared/types.ts';
import companyEn from '../../../content/company.en.json';
import companyPt from '../../../content/company.pt.json';

/** The app's own story: the company, its people, and what shows before a project is downloaded. */
export type Company = typeof companyEn;
/** The company plus the story of the project being played. */
export type Story = Omit<Company, 'pendingProject'> & ProjectStory;

const companies: Record<Language, Company> = { en: companyEn, pt: companyPt };

export function company(language: Language): Company {
  return companies[language];
}

/** The project's story comes with its content (the snapshot); until then, the pending texts show. */
export function story(language: Language, projectStory: Record<Language, ProjectStory> | null): Story {
  const { pendingProject, ...base } = company(language);
  return { ...base, ...(projectStory?.[language] ?? pendingProject) };
}
