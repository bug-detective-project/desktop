import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The checker is a plain Node script without types.
import { checkWorkflows, unpinnedUses } from '../../tools/check-action-pins.mjs';

const HASH = 'a'.repeat(40);

describe('check-action-pins', () => {
  it('accepts actions and reusable workflows pinned by hash', () => {
    const text = [
      'steps:',
      `  - uses: actions/checkout@${HASH} # v4.3.0`,
      `  - uses: "actions/setup-node@${HASH}"`,
      'jobs:',
      '  project:',
      `    uses: bug-detective-project/catalog/.github/workflows/project.yml@${HASH} # v1.2.0`,
    ].join('\n');
    expect(unpinnedUses(text)).toEqual([]);
  });

  it('rejects tags, branches and missing refs', () => {
    const text = ['- uses: actions/checkout@v4', '- uses: actions/setup-node@main', '- uses: owner/action'].join('\n');
    expect(unpinnedUses(text)).toEqual(['1: actions/checkout@v4', '2: actions/setup-node@main', '3: owner/action']);
  });

  it('skips local and docker references', () => {
    expect(unpinnedUses('- uses: ./.github/actions/local\n- uses: docker://alpine:3')).toEqual([]);
  });

  it('reports every workflow file of a folder with its path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pins-'));
    await writeFile(join(dir, 'ok.yml'), `- uses: actions/checkout@${HASH}\n`);
    await writeFile(join(dir, 'bad.yaml'), '- uses: actions/checkout@v4\n');
    await writeFile(join(dir, 'notes.txt'), '- uses: actions/checkout@v4\n');
    expect(await checkWorkflows(dir)).toEqual([`${join(dir, 'bad.yaml')}:1: actions/checkout@v4`]);
  });
});
