import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { textFile } from '@bug-detective/catalog/contract';
import { qaImageTag, writeQaContext } from '../../src/main/services/qa-image.ts';

const tool = [textFile('run.ts', 'cli\n'), textFile('support/app.ts', 'support\n')];

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-qa-image-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('QA image tag', () => {
  it('changes with the QA tool and with the Dockerfile, not with the file order', () => {
    const tag = qaImageTag('abc123', tool);
    expect(tag).toMatch(/^bugdetective-qa:[0-9a-f]{12}$/);
    expect(qaImageTag('abc123', [...tool].reverse())).toBe(tag);
    expect(qaImageTag('abc123', [tool[0], textFile('support/app.ts', 'changed\n')])).not.toBe(tag);
    expect(qaImageTag('def456', tool)).not.toBe(tag);
  });
});

describe('QA build context', () => {
  it('puts the bundled docker/qa files and the QA tool under cli/', async () => {
    const base = join(dir, 'docker', 'qa');
    await mkdir(base, { recursive: true });
    await writeFile(join(base, 'Dockerfile'), 'FROM node\n');
    const context = await writeQaContext(base, 'abc123', tool, join(dir, 'build'));
    expect((await readdir(context, { recursive: true })).sort()).toEqual(['Dockerfile', 'cli', 'cli/run.ts', 'cli/support', 'cli/support/app.ts']);
    expect(await readFile(join(context, 'cli', 'run.ts'), 'utf8')).toBe('cli\n');
    // The same tool reuses the same folder.
    expect(await writeQaContext(base, 'abc123', tool, join(dir, 'build'))).toBe(context);
    // A new Dockerfile (another docker/qa hash) gets a folder of its own.
    await writeFile(join(base, 'Dockerfile'), 'FROM node:26\n');
    const updated = await writeQaContext(base, 'def456', tool, join(dir, 'build'));
    expect(updated).not.toBe(context);
    expect(await readFile(join(updated, 'Dockerfile'), 'utf8')).toBe('FROM node:26\n');
  });
});
