import { describe, expect, it } from 'vitest';
import { CachedContentSource } from '../../src/main/services/content/cache.ts';
import { contentSourceFor } from '../../src/main/services/projects.ts';
import type { ResolvedProject } from '../../src/main/services/catalog.ts';

const supportdesk: ResolvedProject = { id: 'supportdesk', repository: 'bug-detective-project/supportdesk', qaRef: 'qa', starter: true, official: true };

describe('the content source the app builds for a project', () => {
  it('caches a GitHub project in its own content folder, on its qa ref', () => {
    const source = contentSourceFor({ ...supportdesk, qaRef: 'qa-v2.4.1' }, { userData: '/data', minVersion: null }, () => {});
    expect(source).toBeInstanceOf(CachedContentSource);
    expect(source.describe()).toContain('/data/projects/supportdesk/content');
    expect(source.describe()).toContain('qa-v2.4.1');
  });

  it('reads a local qa folder when the catalog entry has one', () => {
    const source = contentSourceFor({ ...supportdesk, qaDir: '/work/supportdesk-qa', official: false }, { userData: '/data', minVersion: '2.0.0' }, () => {});
    expect(source.kind).toBe('local');
    expect(source.describe()).toBe('/work/supportdesk-qa');
  });
});
