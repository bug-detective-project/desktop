import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeStaleWindow, StaleVSCodeWindowError } from '../../src/main/services/attached-window.ts';

describe('the VS Code window left on a removed container', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'attached-window-'));
    file = join(dir, 'nested', 'attached-container');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const guard = (containerId: string, closeWindows: (name: string) => Promise<boolean>) =>
    closeStaleWindow({ file, containerId, containerName: 'bugdetective-workspace', closeWindows });

  it('never touches a window on the first attach, when nothing says it is stale', async () => {
    const closeWindows = vi.fn(async () => true);
    await guard('first', closeWindows);
    expect(closeWindows).not.toHaveBeenCalled();
    expect(await readFile(file, 'utf8')).toBe('first');
  });

  it("leaves the player's window alone while the container is the same one", async () => {
    const closeWindows = vi.fn(async () => true);
    await guard('same', closeWindows);
    await guard('same', closeWindows);
    expect(closeWindows).not.toHaveBeenCalled();
  });

  it('closes the windows of that container once it was recreated', async () => {
    const closeWindows = vi.fn(async () => true);
    await guard('old', closeWindows);
    await guard('new', closeWindows);
    expect(closeWindows).toHaveBeenCalledExactlyOnceWith('bugdetective-workspace');
    expect(await readFile(file, 'utf8')).toBe('new');
  });

  it('asks the player once when the window could not be closed, and the next click attaches', async () => {
    const closeWindows = vi.fn(async () => false);
    await guard('old', closeWindows);
    await expect(guard('new', closeWindows)).rejects.toBeInstanceOf(StaleVSCodeWindowError);
    await expect(guard('new', closeWindows)).resolves.toBeUndefined();
    expect(closeWindows).toHaveBeenCalledTimes(1);
  });

  it('ignores the blank line an editor may leave in the file', async () => {
    const closeWindows = vi.fn(async () => true);
    await guard('same', closeWindows);
    await writeFile(file, 'same\n');
    await guard('same', closeWindows);
    expect(closeWindows).not.toHaveBeenCalled();
  });
});
