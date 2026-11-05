/**
 * A VS Code window attached to a container that was removed gives up reconnecting, and opening the
 * same folder then only focuses that dead window: the CLI returns 0 and nothing attaches. The title
 * of a healthy window is the same, so a window is closed only when the container changed since the
 * last attach, which the app records by container id.
 */
import { readFile } from 'node:fs/promises';
import { writeFileAtomic } from './content/store.ts';

/** The window of a recreated container could not be closed: the player closes it, then opens VS Code again. */
export class StaleVSCodeWindowError extends Error {
  constructor() {
    super('The old VS Code window is still open');
  }
}

export interface StaleWindowOptions {
  /** Where the id of the last attached container is kept: outside Docker, so it survives a cleanup. */
  file: string;
  containerId: string;
  containerName: string;
  /** Closes the windows of that container: true when none is left, false when it cannot tell. */
  closeWindows(containerName: string): Promise<boolean>;
}

/**
 * Call before attaching. The id is saved first, so the player is asked at most once: a platform that
 * cannot see its windows would otherwise never know the player closed it.
 */
export async function closeStaleWindow({ file, containerId, containerName, closeWindows }: StaleWindowOptions): Promise<void> {
  const last = (await readFile(file, 'utf8').catch(() => null))?.trim();
  if (last === containerId) {
    return;
  }
  await writeFileAtomic(file, containerId);
  if (last && !(await closeWindows(containerName))) {
    throw new StaleVSCodeWindowError();
  }
}
