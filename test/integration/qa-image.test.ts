/**
 * The QA image of a QA tool without Playwright (the notes fixture's CLI): it builds without
 * Chromium, and its entry point is the tool's run.ts. Real Docker.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { qaToolFiles } from '@bug-detective/catalog/contract';
import { currentPlatform } from '../../src/main/platform/index.ts';
import { readQaFiles } from '../../src/main/services/content/local-manifest.ts';
import { Docker } from '../../src/main/services/docker.ts';
import { runCommand } from '../../src/main/services/process.ts';
import { qaImageTag, writeQaContext } from '../../src/main/services/qa-image.ts';
import { createNotesProject } from '../helpers/notes-project.ts';

const root = resolve(import.meta.dirname, '..', '..');
const platform = currentPlatform();
let dir: string;
let docker: Docker;
let tag: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-qa-image-'));
  const { cli } = await platform.locateDocker();
  if (!cli) throw new Error('The docker CLI was not found');
  docker = new Docker(cli, runCommand);
  const notes = await createNotesProject(dir);
  const tool = qaToolFiles(await readQaFiles(notes.qaDir, runCommand));
  const { qaBase } = JSON.parse(await readFile(join(root, 'build', 'docker', 'images.json'), 'utf8')) as { qaBase: string };
  tag = qaImageTag(qaBase, tool, 'bugdetective-qa-image-test');
  const context = await writeQaContext(join(root, 'build', 'docker', 'qa'), qaBase, tool, join(dir, 'build'));
  await docker.build(platform.dockerHostPath(context), tag, 'qa-image');
}, 600_000);

afterAll(async () => {
  if (tag) await docker.run(['image', 'rm', '--force', tag]).catch(() => {});
  await rm(dir, { recursive: true, force: true });
});

describe('QA image of a tool without Playwright', () => {
  it('has no Chromium, and runs the tool', async () => {
    const browsers = await docker.run(['run', '--rm', '--entrypoint', 'sh', tag, '-c', 'ls /ms-playwright 2>/dev/null | wc -l']);
    expect(browsers.stdout.toString('utf8').trim()).toBe('0');
    const usage = await docker.run(['run', '--rm', tag]);
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain('Usage: node run.ts');
  });
});
