import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The checker is a plain Node script without types.
import { installedPaths, refusal } from '../../tools/check-installer.mjs';

const hosted = { CI: 'true', GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' };
const script = resolve(import.meta.dirname, '..', '..', 'tools', 'check-installer.mjs');

describe('check-installer, which uninstalls and so deletes the player data', () => {
  it('runs only on a disposable Windows machine of GitHub', () => {
    expect(refusal(hosted, 'win32')).toBeNull();
  });

  it.each([
    ['a developer computer', {}, 'win32'],
    ['a shell that only sets CI', { CI: 'true' }, 'win32'],
    ['a self-hosted runner, which keeps its disk', { ...hosted, RUNNER_ENVIRONMENT: 'self-hosted' }, 'win32'],
    ['Linux', hosted, 'linux'],
  ])('refuses on %s', (_name, env, platform) => {
    expect(refusal(env, platform)).toMatch(/refus/i);
  });

  it('stops before doing anything when it is run by hand', () => {
    const { CI: _ci, GITHUB_ACTIONS: _actions, RUNNER_ENVIRONMENT: _runner, ...env } = process.env;
    const result = spawnSync(process.execPath, [script], { env, encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/refus/i);
  });

  it('knows where a per-user install puts things', () => {
    const paths = installedPaths({ LOCALAPPDATA: 'C:\\L', APPDATA: 'C:\\R', USERPROFILE: 'C:\\U' });
    expect(paths.exe).toBe('C:\\L\\Programs\\Bug Detective\\Bug Detective.exe');
    expect(paths.uninstaller).toBe('C:\\L\\Programs\\Bug Detective\\Uninstall Bug Detective.exe');
    expect(paths.removeDockerData).toBe('C:\\L\\Programs\\Bug Detective\\resources\\remove-docker-data.ps1');
    expect(paths.data).toBe('C:\\R\\Bug Detective');
    expect(paths.shortcuts).toEqual(['C:\\U\\Desktop\\Bug Detective.lnk', 'C:\\R\\Microsoft\\Windows\\Start Menu\\Programs\\Bug Detective.lnk']);
  });
});
