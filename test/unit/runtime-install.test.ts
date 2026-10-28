import { describe, expect, it, vi } from 'vitest';
import type { Platform } from '../../src/main/platform/types.ts';
import { DockerRuntime } from '../../src/main/runtime.ts';

describe('installEnvironment', () => {
  it('moves the workspace to the new image before removing the images of older versions', async () => {
    const runtime = new DockerRuntime({ dockerHostPath: (path: string) => path } as unknown as Platform, { contextRoot: '/nowhere' });
    const calls: string[] = [];
    const internals = runtime as unknown as Record<string, unknown>;
    internals.docker = async () => ({ imageExists: async () => true });
    internals.imageTags = async () => ({ workspace: 'bugdetective-workspace:new', qa: 'bugdetective-qa:new' });
    internals.runningWorkspace = async () => {
      calls.push('workspace');
      return { hasRepository: async () => false };
    };
    vi.spyOn(runtime, 'cleanDocker').mockImplementation(async () => {
      calls.push('cleanup');
      return { removed: 1, failed: [] };
    });
    const lines: string[] = [];
    await runtime.installEnvironment((line) => lines.push(line));
    expect(calls).toEqual(['workspace', 'cleanup']);
    expect(lines).toContain('» Removed 1 item(s) left by older versions');
  });
});
