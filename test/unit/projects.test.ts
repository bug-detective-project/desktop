import { describe, expect, it } from 'vitest';
import catalogJson from '../../content/projects.json' with { type: 'json' };
import {
  chooseContentSource,
  parseLocalProjects,
  parseProjectsCatalog,
  repositoryFromRemote,
  withLocalProjects,
  starterProject,
  updateCatalog,
} from '../../src/main/services/projects.ts';

const supportdesk = { id: 'supportdesk', repository: 'bug-detective-project/supportdesk', starter: true, version: '2.0.0' };
const inventory = { id: 'inventory', repository: 'bug-detective-project/inventory', starter: false, version: '1.0.0' };

describe('projects.json', () => {
  it('lists SupportDesk as the starter project', () => {
    expect(starterProject(parseProjectsCatalog(catalogJson)).id).toBe('supportdesk');
  });

  it('accepts several projects with exactly one starter', () => {
    const catalog = parseProjectsCatalog({ projects: [supportdesk, inventory] });
    expect(starterProject(catalog)).toEqual(supportdesk);
  });

  it('refuses no starter, two starters, a repeated id, an invalid repository or version', () => {
    const invalid = {
      'no starter': [{ ...supportdesk, starter: false }],
      'two starters': [supportdesk, { ...inventory, starter: true }],
      'a repeated id': [supportdesk, { ...inventory, id: 'supportdesk' }],
      'an invalid repository': [{ ...supportdesk, repository: 'supportdesk' }],
      'an invalid version': [{ ...supportdesk, version: '2.0' }],
      'an invalid id': [{ ...supportdesk, id: 'Support Desk' }],
      'no projects': [],
    };
    for (const [name, projects] of Object.entries(invalid)) {
      expect(() => parseProjectsCatalog({ projects }), name).toThrow(/projects\.json/);
    }
  });
});

describe('projects.local.json', () => {
  const catalog = parseProjectsCatalog({ projects: [supportdesk, inventory] });

  it('maps listed projects to local qa folders', () => {
    expect(parseLocalProjects({ supportdesk: '../supportdesk-qa' })).toEqual({ supportdesk: '../supportdesk-qa' });
  });

  it('refuses an empty folder or an invalid project id', () => {
    expect(() => parseLocalProjects({ supportdesk: '' })).toThrow(/projects\.local\.json/);
    expect(() => parseLocalProjects({ 'Not An Id': '../x' })).toThrow(/projects\.local\.json/);
  });

  it('adds a project that only projects.local.json names, in development only', () => {
    const local = parseLocalProjects({ supportdesk: '../supportdesk-qa', sample: '../sample-qa' });
    expect(withLocalProjects(catalog, local, false).projects.map((project) => [project.id, project.starter])).toEqual([
      ['supportdesk', true],
      ['inventory', false],
      ['sample', false],
    ]);
    expect(withLocalProjects(catalog, local, true)).toEqual(catalog);
  });
});

describe('content source of a project', () => {
  it('downloads from the repository by default', () => {
    expect(chooseContentSource(supportdesk, { packaged: false, localDirs: {}, baseDir: '/work/desktop' })).toEqual({
      kind: 'github',
      repository: 'bug-detective-project/supportdesk',
      project: 'supportdesk',
      minVersion: '2.0.0',
    });
  });

  it('reads a local qa folder in development when one is set, relative to the desktop folder', () => {
    expect(chooseContentSource(supportdesk, { packaged: false, localDirs: { supportdesk: '../supportdesk-qa' }, baseDir: '/work/desktop' })).toEqual({
      kind: 'local',
      qaDir: '/work/supportdesk-qa',
      project: 'supportdesk',
    });
  });

  it('always downloads in the installed app, even with a local folder set', () => {
    expect(chooseContentSource(supportdesk, { packaged: true, localDirs: { supportdesk: '../supportdesk-qa' }, baseDir: '/app' }).kind).toBe('github');
  });
});

describe('updating projects.json after a publish', () => {
  const catalog = parseProjectsCatalog({ projects: [supportdesk] });

  it('records the new version of a listed project', () => {
    expect(updateCatalog(catalog, { id: 'supportdesk', repository: supportdesk.repository, version: '2.1.0' }).projects).toEqual([
      { ...supportdesk, version: '2.1.0' },
    ]);
  });

  it('adds a new project, not as the starter', () => {
    expect(updateCatalog(catalog, { id: 'inventory', repository: inventory.repository, version: '1.0.0' }).projects).toEqual([supportdesk, inventory]);
  });

  it('makes the first project the starter', () => {
    expect(updateCatalog({ projects: [] }, { id: 'inventory', repository: inventory.repository, version: '1.0.0' }).projects).toEqual([
      { ...inventory, starter: true },
    ]);
  });

  it('follows a renamed repository', () => {
    expect(updateCatalog(catalog, { id: 'supportdesk', repository: 'other-org/supportdesk', version: '2.1.0' }).projects[0].repository).toBe(
      'other-org/supportdesk',
    );
  });
});

describe('repository from the git remote', () => {
  it('reads owner/name from SSH and HTTPS GitHub URLs', () => {
    expect(repositoryFromRemote('git@github.com:bug-detective-project/supportdesk.git')).toBe('bug-detective-project/supportdesk');
    expect(repositoryFromRemote('https://github.com/bug-detective-project/supportdesk')).toBe('bug-detective-project/supportdesk');
    expect(repositoryFromRemote('https://github.com/bug-detective-project/supportdesk.git\n')).toBe('bug-detective-project/supportdesk');
  });

  it('refuses a remote that is not on GitHub', () => {
    expect(() => repositoryFromRemote('/home/me/supportdesk')).toThrow(/GitHub/);
  });
});

describe('the content source the app builds for a project', () => {
  it('caches a GitHub project in its own content folder', async () => {
    const { contentSourceFor } = await import('../../src/main/services/projects.ts');
    const { CachedContentSource } = await import('../../src/main/services/content/cache.ts');
    const source = contentSourceFor(supportdesk, { packaged: true, localDirs: {}, baseDir: '/app', userData: '/data' }, () => {});
    expect(source).toBeInstanceOf(CachedContentSource);
    expect(source.describe()).toContain('/data/projects/supportdesk/content');
  });

  it('reads a local qa folder in development', async () => {
    const { contentSourceFor } = await import('../../src/main/services/projects.ts');
    const source = contentSourceFor(supportdesk, { packaged: false, localDirs: { supportdesk: '../supportdesk-qa' }, baseDir: '/work/desktop', userData: '/data' }, () => {});
    expect(source.kind).toBe('local');
    expect(source.describe()).toBe('/work/supportdesk-qa');
  });
});
