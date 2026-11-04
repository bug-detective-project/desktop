import { mkdtemp, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildDiagnostics, isWsl, logFileName, openLogsFolder, openWithWindowsExplorer, pruneLogs, recentLines, redactPaths } from '../../src/main/services/logs.ts';

describe('log files', () => {
  it('names the file after the day, in local time', () => {
    expect(logFileName(new Date(2026, 10, 4, 23, 59))).toBe('bug-detective-2026-11-04.log');
  });

  it('keeps the 7 most recent files and ignores other files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bd-logs-'));
    for (let day = 1; day <= 9; day += 1) {
      await writeFile(join(dir, `bug-detective-2026-11-0${day}.log`), 'x');
    }
    await writeFile(join(dir, 'notes.txt'), 'x');
    expect(await pruneLogs(dir)).toEqual(['bug-detective-2026-11-01.log', 'bug-detective-2026-11-02.log']);
    expect((await readdir(dir)).sort()).toHaveLength(8);
    expect(await pruneLogs(join(dir, 'missing'))).toEqual([]);
  });

  it('reads the last lines of a file, and nothing from a missing one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bd-logs-'));
    await writeFile(join(dir, 'a.log'), 'one\ntwo\nthree\n');
    expect(await recentLines(join(dir, 'a.log'), 2)).toEqual(['two', 'three']);
    expect(await recentLines(join(dir, 'b.log'))).toEqual([]);
  });
});

describe('redactPaths', () => {
  it('replaces the home folder in every spelling with ~', () => {
    expect(redactPaths('C:\\Users\\João Silva\\AppData and C:/Users/João Silva/x', 'C:\\Users\\João Silva')).toBe('~\\AppData and ~/x');
    expect(redactPaths('/home/pleao/project', '/home/pleao')).toBe('~/project');
    expect(redactPaths('nothing', '')).toBe('nothing');
  });
});

describe('buildDiagnostics', () => {
  it('lists the versions, the checks, the game and the recent log, with paths redacted', () => {
    const text = buildDiagnostics({
      appVersion: '0.3.0',
      versions: { electron: '40.0.0', node: '26.12.1', chrome: '140.0.0' },
      os: { platform: 'win32', release: '10.0.26100', version: 'Windows 11 Pro', arch: 'x64' },
      checks: [
        { id: 'docker', status: 'ok', version: '28.0.1' },
        { id: 'vscode', status: 'missing', reason: 'not found' },
      ],
      project: { id: 'supportdesk', name: 'SupportDesk', manifestVersion: '2.6.0' },
      dockerState: 'running',
      environment: { items: [{ id: 'workspaceImage', ready: true }, { id: 'qaImage', ready: false }], ready: false },
      logLines: ['» Fetching front-1', 'saved C:\\Users\\João Silva\\AppData\\Roaming\\Bug Detective\\state.json'],
      home: 'C:\\Users\\João Silva',
      now: new Date('2026-11-04T10:00:00.000Z'),
    });
    expect(text).toContain('Bug Detective 0.3.0 diagnostics, 2026-11-04T10:00:00.000Z');
    expect(text).toContain('## Versions');
    expect(text).toContain('docker: ok (28.0.1)');
    expect(text).toContain('vscode: missing: not found');
    expect(text).toContain('wsl: not checked');
    expect(text).toContain('project: SupportDesk (supportdesk) 2.6.0');
    expect(text).toContain('environment: not ready (workspaceImage=ok, qaImage=missing)');
    expect(text).toContain('## Log (last 2 lines)');
    expect(text).toContain('saved ~\\AppData\\Roaming\\Bug Detective\\state.json');
    expect(text).not.toContain('João Silva');
  });
});

describe('openLogsFolder', () => {
  it('creates the folder when nothing was logged yet, then opens it', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'bd-logs-')), 'logs');
    const opened: string[] = [];
    await openLogsFolder(dir, async (path) => {
      opened.push(path);
      return '';
    });
    expect(opened).toEqual([dir]);
    expect((await stat(dir)).isDirectory()).toBe(true);
  });

  it('turns the message shell.openPath resolves with into a rejection', async () => {
    const dir = join(await mkdtemp(join(tmpdir(), 'bd-logs-')), 'logs');
    await expect(openLogsFolder(dir, async () => 'Failed to open path')).rejects.toThrow('Failed to open path');
  });
});

describe('openWithWindowsExplorer', () => {
  const enoent = () => Object.assign(new Error('spawn explorer.exe ENOENT'), { code: 'ENOENT' });

  it('is the opener only for development under WSL', () => {
    expect(isWsl('linux', { WSL_DISTRO_NAME: 'Ubuntu-22.04' })).toBe(true);
    expect(isWsl('linux', { WSL_INTEROP: '/run/WSL/1_interop' })).toBe(true);
    expect(isWsl('linux', {})).toBe(false);
    expect(isWsl('win32', { WSL_DISTRO_NAME: 'Ubuntu-22.04' })).toBe(false);
  });

  it('opens the folder\'s Windows path in Explorer, whose exit code 1 is not a failure', async () => {
    const calls: [string, string[]][] = [];
    const exec = async (file: string, args: string[]) => {
      calls.push([file, args]);
      if (file === 'wslpath') return { stdout: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\logs\n' };
      throw Object.assign(new Error('Command failed: explorer.exe'), { code: 1 });
    };
    await expect(openWithWindowsExplorer('/home/dev/logs', exec)).resolves.toBe('');
    expect(calls).toEqual([
      ['wslpath', ['-w', '/home/dev/logs']],
      ['explorer.exe', ['\\\\wsl.localhost\\Ubuntu\\home\\dev\\logs']],
    ]);
  });

  it('reports a missing wslpath or explorer.exe', async () => {
    await expect(openWithWindowsExplorer('/home/dev/logs', async () => { throw enoent(); })).resolves.toContain('wslpath:');
    const exec = async (file: string) => {
      if (file === 'wslpath') return { stdout: 'C:\\x\n' };
      throw enoent();
    };
    await expect(openWithWindowsExplorer('/home/dev/logs', exec)).resolves.toContain('explorer.exe:');
  });
});
