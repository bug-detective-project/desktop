/**
 * The QA image is built on the player's computer from the app's docker/qa/ files plus the QA tool
 * of the project being played (its qa branch without the tickets), which arrives with the
 * project's content. Its tag hashes both, so a new Dockerfile or a newly published QA tool gives a
 * new image.
 */
import { cp, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256Hex, treeDigest } from './content/archive.ts';
import type { ArchiveFile } from './content/archive.ts';

/** <repository>:<hash of the docker/qa files and the QA tool>. */
export function qaImageTag(qaBase: string, tool: readonly ArchiveFile[], repository = 'bugdetective-qa'): string {
  return `${repository}:${sha256Hex(`${qaBase}\n${treeDigest(tool)}`).slice(0, 12)}`;
}

/** Writes (once) the build context: the docker/qa files plus the tool under cli/. Returns its folder. */
export async function writeQaContext(qaBaseDir: string, qaBase: string, tool: readonly ArchiveFile[], buildRoot: string): Promise<string> {
  // Named like the image tag, so a new Dockerfile or a new tool never reuses an older folder.
  const target = join(buildRoot, `qa-${qaImageTag(qaBase, tool).split(':')[1]}`);
  // The marker sits next to the folder, so it never becomes part of the build context.
  const marker = `${target}.complete`;
  if (existsSync(marker) && existsSync(target)) {
    return target;
  }
  const staging = join(buildRoot, `.staging-${randomUUID()}`);
  try {
    await cp(qaBaseDir, staging, { recursive: true });
    for (const file of tool) {
      const path = join(staging, 'cli', ...file.path.split('/'));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.data);
    }
    await rm(target, { recursive: true, force: true });
    await rename(staging, target);
    await writeFile(marker, '');
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return target;
}
