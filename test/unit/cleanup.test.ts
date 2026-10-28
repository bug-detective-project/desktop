import { describe, expect, it } from 'vitest';
import { planCleanup } from '../../src/main/services/cleanup.ts';
import type { LabelledResources } from '../../src/main/services/cleanup.ts';

// What `docker … ls --filter label=bugdetective.role` could return on a player's (or developer's) computer.
const found: LabelledResources = {
  containers: ['bugdetective-workspace', 'bugdetective-qa-1a2b3c4d', 'bugdetective-qa-copy-5e6f7a8b', 'bugdetective-test-workspace', 'someone-else'],
  volumes: ['bugdetective-workspace', 'bugdetective-vscode-server', 'bugdetective-qa-cache', 'bugdetective-qa-input', 'bugdetective-test-workspace', 'other'],
  images: [
    { ref: 'bugdetective-workspace:281e4701af14', id: 'aaa' },
    { ref: 'bugdetective-workspace:0ld0ld0ld0ld', id: 'bbb' },
    { ref: 'bugdetective-qa:9c8db3bee0fc', id: 'ccc' },
    { ref: '<none>:<none>', id: 'ddd' },
    { ref: 'labelled-by-someone:1', id: 'eee' },
  ],
};
const options = {
  prefix: 'bugdetective',
  qaInputVolume: 'bugdetective-qa-input',
  currentImages: ['bugdetective-workspace:281e4701af14', 'bugdetective-qa:9c8db3bee0fc'],
};
const names = (scope: 'leftovers' | 'everything') => planCleanup(found, { ...options, scope }).map((target) => `${target.kind} ${target.name}`);

describe('Docker cleanup plan', () => {
  it('leftovers: QA containers, the QA input volume and images of older versions; the player work stays', () => {
    expect(names('leftovers')).toEqual([
      'container bugdetective-qa-1a2b3c4d',
      'container bugdetective-qa-copy-5e6f7a8b',
      'volume bugdetective-qa-input',
      'image bugdetective-workspace:0ld0ld0ld0ld',
      'image ddd',
    ]);
  });

  it('everything: every container, volume and image of the app, containers first', () => {
    expect(names('everything')).toEqual([
      'container bugdetective-workspace',
      'container bugdetective-qa-1a2b3c4d',
      'container bugdetective-qa-copy-5e6f7a8b',
      'container bugdetective-test-workspace',
      'volume bugdetective-workspace',
      'volume bugdetective-vscode-server',
      'volume bugdetective-qa-cache',
      'volume bugdetective-qa-input',
      'volume bugdetective-test-workspace',
      'image bugdetective-workspace:281e4701af14',
      'image bugdetective-workspace:0ld0ld0ld0ld',
      'image bugdetective-qa:9c8db3bee0fc',
      'image ddd',
    ]);
  });

  it('never touches resources without the app prefix or image repository', () => {
    const all = names('everything').join('\n');
    expect(all).not.toContain('someone-else');
    expect(all).not.toContain('volume other');
    expect(all).not.toContain('labelled-by-someone');
  });

  it('a test prefix keeps the player resources', () => {
    const plan = planCleanup(found, { ...options, prefix: 'bugdetective-test', qaInputVolume: 'bugdetective-test-qa-input', scope: 'everything' });
    expect(plan.filter((target) => target.kind !== 'image').map((target) => target.name)).toEqual(['bugdetective-test-workspace', 'bugdetective-test-workspace']);
  });

  it('a cleanup of leftovers never touches another project (new projects arrive as resources of their own)', () => {
    const withAnotherProject: LabelledResources = {
      containers: [...found.containers, 'bugdetective-tasklist-workspace', 'bugdetective-tasklist-qa-1a2b3c4d'],
      volumes: [...found.volumes, 'bugdetective-tasklist-workspace', 'bugdetective-tasklist-qa-input'],
      images: [...found.images, { ref: 'bugdetective-tasklist-workspace:0ld0ld0ld0ld', id: 'fff' }],
    };
    const plan = planCleanup(withAnotherProject, { ...options, scope: 'leftovers' }).map((target) => target.name).join('\n');
    expect(plan).not.toContain('tasklist');
  });
});

