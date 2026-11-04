/**
 * The log files and the diagnostics text. One file per day the app started
 * (<userData>/logs/bug-detective-<YYYY-MM-DD>.log), the 7 most recent kept; every line is
 * written with the user's home folder replaced by "~", so a diagnostics text shared for support
 * carries no user name. electron-log does the writing (index.ts); this module has no Electron
 * dependency, so it is tested as plain Node.
 */
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { CheckResult, EngineState, EnvironmentReport } from '../../shared/api.ts';

export const LOG_FILES_KEPT = 7;
export const DIAGNOSTICS_LOG_LINES = 200;

/** bug-detective-YYYY-MM-DD.log, in local time. */
export function logFileName(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `bug-detective-${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}.log`;
}

const LOG_FILE = /^bug-detective-\d{4}-\d{2}-\d{2}\.log$/;

/** Removes the oldest log files beyond the ones kept (by name: the date is in it). */
export async function pruneLogs(dir: string, keep = LOG_FILES_KEPT): Promise<string[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => LOG_FILE.test(name)).sort();
  } catch {
    return [];
  }
  const removed = names.slice(0, Math.max(0, names.length - keep));
  for (const name of removed) {
    await rm(join(dir, name), { force: true });
  }
  return removed;
}

/** The user's home folder as "~", in every spelling Windows and WSL use for it. */
export function redactPaths(line: string, home: string): string {
  if (!home) {
    return line;
  }
  const variants = [home, home.replaceAll('\\', '/'), home.replaceAll('/', '\\')];
  let result = line;
  for (const variant of new Set(variants)) {
    if (variant) {
      result = result.split(variant).join('~');
    }
  }
  return result;
}

/**
 * Opens the logs folder with `open` (Electron's shell.openPath, which resolves with an error
 * message instead of rejecting). The folder is created first: electron-log creates it at the
 * first write, which may not have happened yet.
 */
export async function openLogsFolder(dir: string, open: (path: string) => Promise<string>): Promise<void> {
  await mkdir(dir, { recursive: true });
  const problem = await open(dir);
  if (problem) {
    throw new Error(`[logsFolderFailed] ${problem}`);
  }
}

/** The last `count` lines of a file, or [] when it does not exist. */
export async function recentLines(file: string, count = DIAGNOSTICS_LOG_LINES): Promise<string[]> {
  try {
    return (await readFile(file, 'utf8')).split(/\r?\n/).filter(Boolean).slice(-count);
  } catch {
    return [];
  }
}

export interface DiagnosticsInput {
  appVersion: string;
  versions: { electron: string; node: string; chrome: string };
  os: { platform: string; release: string; version: string; arch: string };
  checks: CheckResult[];
  project: { id: string; name: string; manifestVersion: string } | null;
  dockerState: EngineState | null;
  environment: EnvironmentReport | null;
  logLines: string[];
  home: string;
  now: Date;
}

/** The text "Copy diagnostics" puts in the clipboard: versions, the environment and the recent log, with paths redacted. */
export function buildDiagnostics(input: DiagnosticsInput): string {
  const check = (id: CheckResult['id']) => {
    const found = input.checks.find((item) => item.id === id);
    return found ? `${found.status}${found.version ? ` (${found.version})` : ''}${found.reason ? `: ${found.reason}` : ''}` : 'not checked';
  };
  const lines = [
    `Bug Detective ${input.appVersion} diagnostics, ${input.now.toISOString()}`,
    '',
    '## Versions',
    `app: ${input.appVersion}`,
    `electron: ${input.versions.electron}`,
    `node: ${input.versions.node}`,
    `chrome: ${input.versions.chrome}`,
    `os: ${input.os.platform} ${input.os.release} (${input.os.version}, ${input.os.arch})`,
    `docker: ${check('docker')}`,
    `wsl: ${check('wsl')}`,
    `vscode: ${check('vscode')}`,
    `devcontainers: ${check('devcontainers')}`,
    '',
    '## Game',
    `project: ${input.project ? `${input.project.name} (${input.project.id}) ${input.project.manifestVersion}` : 'none'}`,
    `docker state: ${input.dockerState ?? 'unknown'}`,
    `environment: ${input.environment ? `${input.environment.ready ? 'ready' : 'not ready'} (${input.environment.items.map((item) => `${item.id}=${item.ready ? 'ok' : 'missing'}`).join(', ')})` : 'not checked'}`,
    '',
    `## Log (last ${input.logLines.length} lines)`,
    ...input.logLines,
    '',
  ];
  return redactPaths(lines.join('\n'), input.home);
}
