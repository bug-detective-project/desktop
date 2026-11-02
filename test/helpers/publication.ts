/**
 * Publishes a test project the way the catalog's bd publish does, without pushing: manifest.json,
 * one tag per new ticket commit and a commit on qa.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectManifest } from '@bug-detective/catalog/contract';
import { buildManifest } from '../../src/main/services/content/local-manifest.ts';
import { runCommand } from '../../src/main/services/process.ts';
import type { ProjectRepo } from './project-repo.ts';

export async function publishLocally(repo: ProjectRepo, version: string): Promise<{ manifest: ProjectManifest }> {
  const manifest = await buildManifest({ qaDir: repo.qaDir, version, runner: runCommand });
  await writeFile(join(repo.qaDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  for (const entry of manifest.entries) {
    if (!repo.git(repo.qaDir, 'tag', '-l', entry.tag)) {
      repo.git(repo.qaDir, 'tag', entry.tag, entry.commit);
    }
  }
  repo.git(repo.qaDir, 'add', 'manifest.json');
  repo.git(repo.qaDir, 'commit', '-q', '-m', `Publish ${manifest.project.name} ${version}`, '--', 'manifest.json');
  return { manifest };
}
