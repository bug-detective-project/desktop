import { describe, expect, it } from 'vitest';
import { textFile } from '../../src/main/services/content/archive.ts';
import { parseProjectStory, projectContentOf, qaToolFiles } from '../../src/main/services/content/project-files.ts';

const message = { subject: 'Subject', body: 'Body' };
export const story = {
  client: { name: 'Harborline', about: 'Outdoor gear', contacts: 'Hannah', reporters: [{ name: 'Hannah', role: 'Support lead' }] },
  project: { name: 'SupportDesk', about: 'A support app', stack: 'React' },
  messages: { welcome: message, assignments: { 'front-1': message }, completion: message, trackCompletion: message },
};

describe('project story', () => {
  it('accepts a story with assignments by ticket id', () => {
    expect(parseProjectStory(story, 'story.en.json').messages.assignments['front-1']).toEqual(message);
  });

  it('refuses assignments by position, a missing part or an empty text', () => {
    const invalid = {
      'assignments by position': { ...story, messages: { ...story.messages, assignments: { '1': message } } },
      'no client': { ...story, client: undefined },
      'no track completion': { ...story, messages: { ...story.messages, trackCompletion: undefined } },
      'an empty subject': { ...story, messages: { ...story.messages, welcome: { subject: '', body: 'x' } } },
    };
    for (const [name, raw] of Object.entries(invalid)) {
      expect(() => parseProjectStory(raw, 'story.en.json'), name).toThrow(/story\.en\.json/);
    }
  });
});

describe('files of the qa branch', () => {
  const qaFiles = [
    textFile('run.ts', 'cli\n'),
    textFile('support/app.ts', 'support\n'),
    textFile('package.json', '{}\n'),
    textFile('manifest.json', '{}\n'),
    textFile('review.json', '{ "exclude": ["docs/**"] }\n'),
    textFile('story.en.json', JSON.stringify(story)),
    textFile('story.pt.json', JSON.stringify(story)),
    textFile('tickets/front-1/ticket.en.md', '# 1\n'),
  ];

  it('builds the QA tool without the tickets, the manifest, the review configuration or the story', () => {
    expect(qaToolFiles(qaFiles).map((file) => file.path).sort()).toEqual(['package.json', 'run.ts', 'support/app.ts']);
  });

  it('reads the review configuration and the story in both languages', () => {
    const content = projectContentOf(qaFiles);
    expect(content.review.exclude).toContain('docs/**');
    expect(content.story.en.project.name).toBe('SupportDesk');
    expect(content.story.pt.client.name).toBe('Harborline');
  });

  it('uses the default review configuration when the project has none', () => {
    const content = projectContentOf(qaFiles.filter((file) => file.path !== 'review.json'));
    expect(content.review.includeTests).toBe(true);
  });

  it('refuses a qa branch without its story', () => {
    expect(() => projectContentOf(qaFiles.filter((file) => file.path !== 'story.pt.json'))).toThrow(/story\.pt\.json/);
  });
});
