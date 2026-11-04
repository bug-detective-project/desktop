/**
 * What the app writes so VS Code attaches to the workspace container without carrying the
 * player's credentials: the Dev Containers per-container configuration file, and the machine
 * settings merged inside the container (the merge script runs with the local node here).
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serviceRunning, hasGitHubCredential } from '../../src/main/platform/types.ts';
import { VSCODE_MACHINE_SETTINGS, VSCode, attachedContainerConfig, attachedContainerConfigPath } from '../../src/main/services/vscode.ts';
import { MERGE_SETTINGS_SCRIPT } from '../../src/main/services/workspace.ts';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'bd-vscode-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the attached-container configuration file', () => {
  it('names the file after the container, escaping what the extension escapes', () => {
    expect(attachedContainerConfigPath('/gs', 'bugdetective-workspace')).toBe(join('/gs', 'ms-vscode-remote.remote-containers', 'nameConfigs', 'bugdetective-workspace.json'));
    expect(attachedContainerConfigPath('/gs', 'a:b/c%d')).toBe(join('/gs', 'ms-vscode-remote.remote-containers', 'nameConfigs', 'a%3ab%2fc%25d.json'));
  });

  it('sets the folder, the node user, no SSH agent socket and the settings, keeping other keys of an existing file', () => {
    const config = attachedContainerConfig('/workspaces/supportdesk', { forwardPorts: [9229], remoteEnv: { FOO: 'bar' }, settings: { 'editor.fontSize': 14 as never } });
    expect(config).toEqual({
      forwardPorts: [9229],
      workspaceFolder: '/workspaces/supportdesk',
      remoteUser: 'node',
      remoteEnv: { FOO: 'bar', SSH_AUTH_SOCK: null },
      settings: { 'editor.fontSize': 14, ...VSCODE_MACHINE_SETTINGS },
    });
    expect(VSCODE_MACHINE_SETTINGS).toMatchObject({ 'dev.containers.gitCredentialHelperConfigLocation': 'none', 'dev.containers.copyGitConfig': false, 'remote.downloadExtensionsLocally': true });
    expect(() => attachedContainerConfig('/etc')).toThrow(/Invalid workspace folder/);
  });

  it('is written into the VS Code global storage of the CLI that will open the window, and merged over a damaged file', async () => {
    const cli = { source: 'path' as const, launcher: 'code', command: 'code', baseArgs: [], env: {}, globalStorage: dir };
    const vscode = new VSCode(cli, async () => ({ code: 0, stdout: Buffer.from(''), stderr: '', timedOut: false }));
    const file = await vscode.writeAttachedConfig('bugdetective-workspace', '/workspaces/supportdesk');
    expect(file).toBe(attachedContainerConfigPath(dir, 'bugdetective-workspace'));
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ workspaceFolder: '/workspaces/supportdesk', remoteUser: 'node', remoteEnv: { SSH_AUTH_SOCK: null } });
    await writeFile(file, '{ not json');
    await vscode.writeAttachedConfig('bugdetective-workspace', '/workspaces/supportdesk');
    expect(JSON.parse(await readFile(file, 'utf8')).remoteUser).toBe('node');
  });
});

describe('the machine settings merge script', () => {
  const run = (file: string, settings: Record<string, unknown>) => execFileSync(process.execPath, ['-e', MERGE_SETTINGS_SCRIPT, file, JSON.stringify(settings)], { encoding: 'utf8' });

  it('creates the folder and the file, and keeps what the file already had', async () => {
    const file = join(dir, 'data', 'Machine', 'settings.json');
    run(file, { 'dev.containers.copyGitConfig': false });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ 'dev.containers.copyGitConfig': false });
    await writeFile(file, JSON.stringify({ 'editor.fontSize': 14, 'dev.containers.copyGitConfig': true }));
    run(file, VSCODE_MACHINE_SETTINGS);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ 'editor.fontSize': 14, ...VSCODE_MACHINE_SETTINGS });
    await writeFile(file, 'garbage');
    run(file, { a: 1 });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ a: 1 });
  });
});

describe('host credential signals', () => {
  it('reads sc query and cmdkey output', () => {
    expect(serviceRunning('SERVICE_NAME: ssh-agent\r\n        STATE              : 4  RUNNING\r\n')).toBe(true);
    expect(serviceRunning('        STATE              : 1  STOPPED\r\n')).toBe(false);
    expect(hasGitHubCredential('Target: LegacyGeneric:target=git:https://github.com\r\n')).toBe(true);
    expect(hasGitHubCredential('Target: LegacyGeneric:target=GitHub - https://api.github.com/x\r\n')).toBe(false);
  });
});
