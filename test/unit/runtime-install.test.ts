import { describe, expect, it, vi } from 'vitest';
import type { Platform } from '../../src/main/platform/types.ts';
import { DockerRuntime } from '../../src/main/runtime.ts';

describe('installEnvironment', () => {
  it('moves the workspace to the new image before removing the images of older versions', async () => {
    const runtime = new DockerRuntime({ dockerHostPath: (path: string) => path } as unknown as Platform, { contextRoot: '/nowhere', qaBuildRoot: '/nowhere/qa' });
    const calls: string[] = [];
    const internals = runtime as unknown as Record<string, unknown>;
    internals.docker = async () => ({ imageExists: async () => true });
    internals.imageTags = async () => ({ workspace: 'bugdetective-workspace:new', qaBase: 'abc' });
    runtime.setQaTool([]);
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

describe('workspaceStatus', () => {
  const runtimeWith = (info: { running: boolean; ports: Record<number, number> } | null) => {
    const runtime = new DockerRuntime({ dockerHostPath: (path: string) => path } as unknown as Platform, { contextRoot: '/nowhere', qaBuildRoot: '/nowhere/qa' });
    const ensureRunning = vi.fn();
    (runtime as unknown as Record<string, unknown>).workspace = async () => ({
      info: async () => info,
      ports: async () => (info ? { client: info.ports[15173], api: info.ports[3001] } : null),
      isDevServerUp: async () => true,
      currentBranch: async () => 'player/ticket-1',
      ensureRunning,
    });
    return { runtime, ensureRunning };
  };

  it('reads the running container without starting or recreating anything', async () => {
    const { runtime, ensureRunning } = runtimeWith({ running: true, ports: { 15173: 5174, 3001: 3002 } });
    expect(await runtime.workspaceStatus()).toEqual({ ports: { client: 5174, api: 3002 }, devServerUp: true, branch: 'player/ticket-1' });
    expect(ensureRunning).not.toHaveBeenCalled();
  });

  it('reports a stopped or missing container as not running, and leaves it as it is', async () => {
    for (const info of [{ running: false, ports: { 15173: 5173, 3001: 3001 } }, null]) {
      const { runtime, ensureRunning } = runtimeWith(info);
      expect(await runtime.workspaceStatus()).toEqual({ ports: null, devServerUp: false, branch: null });
      expect(ensureRunning).not.toHaveBeenCalled();
    }
  });
});
