import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import electronPath from 'electron';

test('startup: a failed start reports why and quits instead of running without a window', async () => {
  const userData = await mkdtemp(join(tmpdir(), 'João Silva e2e-'));
  try {
    // A game saved by a newer version cannot be loaded.
    await writeFile(join(userData, 'state.json'), JSON.stringify({ schemaVersion: 99 }));
    const { ELECTRON_RUN_AS_NODE: _ignored, ...parentEnv } = process.env;
    const child = spawn(electronPath as unknown as string, [resolve(import.meta.dirname, '..', '..')], {
      env: { ...parentEnv, BUGDETECTIVE_E2E: '1', BUGDETECTIVE_USER_DATA: userData },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    const exited = await new Promise<boolean>((done) => {
      const timer = setTimeout(() => {
        child.kill();
        done(false);
      }, 30_000);
      child.on('exit', () => {
        clearTimeout(timer);
        done(true);
      });
    });
    expect(exited).toBe(true);
    expect(stderr).toContain('Bug Detective could not start');
    expect(stderr).toContain('newer version');
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});
