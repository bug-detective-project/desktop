/** Electron main process: window, security settings, services and IPC. */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { homedir, release, version as osVersion } from 'node:os';
import { app, BrowserWindow, dialog, screen, session, shell } from 'electron';
import log from 'electron-log/main';
import icon from '../../resources/icon.png?asset';
import type { Snapshot } from '../shared/api.ts';
import { attachDevToolsShortcuts, loadReactDevTools } from './devtools.ts';
import { FakeRuntime } from './fake-runtime.ts';
import { Game } from './game.ts';
import type { DevCatalogOptions } from './game.ts';
import { channelName, registerIpc } from './ipc.ts';
import { startupErrorText } from './startup-error.ts';
import { currentPlatform } from './platform/index.ts';
import type { Platform } from './platform/types.ts';
import { DockerRuntime } from './runtime.ts';
import type { GameRuntime } from './runtime.ts';
import { CatalogService, chooseCatalogSource, parseLocalCatalog, readLocalCatalogFile, writeLocalCatalogFile } from './services/catalog.ts';
import type { LocalCatalog, ResolvedProject } from './services/catalog.ts';
import { contentSourceFor } from './services/projects.ts';
import { PackageStore } from './services/content/store.ts';
import { skipWhileRunning } from './services/poll.ts';
import { ReviewStore } from './services/review/store.ts';
import { StateStore } from './services/state.ts';
import { isWsl, logFileName, openLogsFolder, openWithWindowsExplorer, pruneLogs, recentLines, redactPaths } from './services/logs.ts';

// Tests and the "clean profile" checks can point the app at another data folder.
if (process.env.BUGDETECTIVE_USER_DATA) {
  app.setPath('userData', resolve(process.env.BUGDETECTIVE_USER_DATA));
}

const isE2E = process.env.BUGDETECTIVE_E2E === '1' && !app.isPackaged;

// One log file per day the app starts, in <userData>/logs, the 7 most recent kept; every line
// with the home folder as "~". console.* of the main process goes there too (and to the terminal).
const logsDir = join(app.getPath('userData'), 'logs');
const logFile = join(logsDir, logFileName(new Date()));
const home = homedir();
log.transports.file.resolvePathFn = () => logFile;
log.transports.file.level = 'info';
log.transports.console.level = app.isPackaged ? false : 'info';
log.hooks.push((message) => ({ ...message, data: message.data.map((item) => (typeof item === 'string' ? redactPaths(item, home) : item)) }));
Object.assign(console, log.functions);
void pruneLogs(logsDir);
// The first line of the day's file, so every start leaves a trace for the diagnostics.
console.info(`Bug Detective ${app.getVersion()} started (${process.platform} ${process.arch}, Electron ${process.versions.electron}${isWsl() ? ', under WSL' : ''})`);
const appRoot = app.getAppPath();
const devRendererUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
// Chrome and React DevTools for development; the e2e tests stay offline and unchanged.
const devTools = !app.isPackaged && !isE2E;

// Development only: desktop/.env (never packaged; the e2e tests pass their variables themselves).
const envFile = join(appRoot, '.env');
if (!app.isPackaged && !isE2E && existsSync(envFile)) {
  process.loadEnvFile(envFile);
}
// "Solve bug" on the board card: BUGDETECTIVE_DEV_SOLVE_BUG_BUTTON=true, never in the installed app.
const devSolveBug = !app.isPackaged && /^(true|1)$/i.test(process.env.BUGDETECTIVE_DEV_SOLVE_BUG_BUTTON ?? '');
// "Skip onboarding" in Rafaela's onboarding: BUGDETECTIVE_DEV_SKIP_ONBOARDING_BUTTON=true, never in the installed app.
const devSkipOnboarding = !app.isPackaged && /^(true|1)$/i.test(process.env.BUGDETECTIVE_DEV_SKIP_ONBOARDING_BUTTON ?? '');
// The Projects screen from the start (it normally waits for a done project): BUGDETECTIVE_DEV_SHOW_PROJECTS=true, never in the installed app.
const devShowProjects = !app.isPackaged && /^(true|1)$/i.test(process.env.BUGDETECTIVE_DEV_SHOW_PROJECTS ?? '');
// The e2e tests keep the onboarding from opening on its own unless BUGDETECTIVE_E2E_SHOW_ONBOARDING=true.
const autoOnboarding = !isE2E || /^(true|1)$/i.test(process.env.BUGDETECTIVE_E2E_SHOW_ONBOARDING ?? '');

/**
 * Development only: desktop/catalog.local.json may point at another projects catalog (a branch of
 * the catalog repository, or a file) and override a project's qa ref or folder. The tests use
 * BUGDETECTIVE_CATALOG_FILE instead. The installed app always reads the official catalog. An
 * invalid file reads as the defaults, and Settings → Development shows why.
 */
function localCatalog(file: string): LocalCatalog | null {
  if (app.isPackaged || !existsSync(file)) {
    return null;
  }
  try {
    return parseLocalCatalog(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) {
    console.log(`» ${file} ignored: ${(error as Error).message}`);
    return null;
  }
}

/** Where Settings → Development keeps catalog.local.json; the e2e tests use their data folder, never the developer's file. */
function localCatalogFile(userData: string): string {
  return join(isE2E ? userData : appRoot, 'catalog.local.json');
}

/** The projects catalog: downloaded at run time, cached in the data folder, with the copy bundled at build time as a fallback. */
function catalogService(userData: string): CatalogService {
  const local = localCatalog(localCatalogFile(userData));
  return new CatalogService({
    choice: chooseCatalogSource({ packaged: app.isPackaged, env: process.env, localCatalog: local, baseDir: appRoot }),
    overrides: local?.projects ?? {},
    baseDir: appRoot,
    cacheFile: join(userData, 'catalog.json'),
    fallbackFile: app.isPackaged ? join(process.resourcesPath, 'catalog.fallback.json') : join(appRoot, 'build', 'catalog.fallback.json'),
    log: console.log,
  });
}

/** Settings → Development: reads and writes catalog.local.json and points the catalog at it without a restart. */
function devCatalogOptions(file: string, catalog: CatalogService): DevCatalogOptions {
  return {
    file,
    testFile: Boolean(process.env.BUGDETECTIVE_CATALOG_FILE),
    read: () => readLocalCatalogFile(file),
    write: (settings) => writeLocalCatalogFile(file, settings),
    reconfigure: (settings) =>
      catalog.reconfigure(chooseCatalogSource({ packaged: app.isPackaged, env: process.env, localCatalog: settings, baseDir: appRoot }), settings.projects ?? {}),
  };
}

const platform: Platform | null = isE2E ? null : currentPlatform();

function runtime(): GameRuntime {
  if (!platform) {
    const fake = new FakeRuntime(process.env.BUGDETECTIVE_E2E_SCENARIO);
    // The e2e tests reach it with app.evaluate to simulate changes made outside the app.
    (globalThis as { bugDetectiveFake?: FakeRuntime }).bugDetectiveFake = fake;
    return fake;
  }
  const contextRoot = app.isPackaged ? join(process.resourcesPath, 'docker') : join(appRoot, 'build', 'docker');
  return new DockerRuntime(platform, { contextRoot, qaBuildRoot: join(app.getPath('userData'), 'docker') });
}

/** Opens an allowlisted URL with the platform's browser command (WSL: the Windows browser). */
async function openUrl(url: string): Promise<void> {
  const command = platform?.browserCommand(url);
  if (!command) {
    await shell.openExternal(url);
    return;
  }
  const child = spawn(command.command, command.args, { detached: true, stdio: 'ignore', shell: false });
  child.on('error', () => {});
  child.unref();
}

function hardenSessions(): void {
  // No permission (camera, notifications, ...) is ever needed, except writing to the clipboard
  // ("Copy log"); reading it stays denied.
  const allowed = (permission: string) => permission === 'clipboard-sanitized-write';
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => callback(allowed(permission)));
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => allowed(permission));

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-attach-webview', (event) => event.preventDefault());
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('will-navigate', (event, url) => {
      const allowed = devRendererUrl ? url.startsWith(devRendererUrl) : url.startsWith('file://');
      if (!allowed) {
        event.preventDefault();
      }
    });
  });
}

function createWindow(): BrowserWindow {
  // Fits a 14-inch laptop's work area; the renderer scrolls below its 1280 x 640 minimum layout.
  const { workAreaSize } = screen.getPrimaryDisplay();
  const window = new BrowserWindow({
    width: Math.min(1360, workAreaSize.width),
    height: Math.min(880, workAreaSize.height),
    minWidth: 960,
    minHeight: 540,
    show: false,
    title: 'Bug Detective',
    // Windows takes the icon from the executable; Linux (and WSLg) needs it on the window.
    icon,
    autoHideMenuBar: true,
    backgroundColor: '#0f172a',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
    },
  });
  window.once('ready-to-show', () => window.show());
  if (devTools) {
    attachDevToolsShortcuts(window);
  }
  if (devRendererUrl) {
    void window.loadURL(devRendererUrl);
  } else {
    void window.loadFile(join(import.meta.dirname, '../renderer/index.html'));
  }
  return window;
}

async function main(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  await app.whenReady();
  hardenSessions();

  const userData = app.getPath('userData');
  let window: BrowserWindow | null = null;
  const catalog = catalogService(userData);
  const contentSource = (project: ResolvedProject, minVersion: string | null) => contentSourceFor(project, { userData, minVersion }, console.log);
  // The starter until the game names its own project (Game.init points everything at that one).
  const starter = (await catalog.current()).find((item) => item.starter)!;
  const game = new Game({
    store: new StateStore(userData),
    // Downloaded packages and reviews belong to the project they came from.
    packages: new PackageStore(join(userData, 'projects', starter.id, 'packages')),
    reviews: new ReviewStore(join(userData, 'projects', starter.id, 'reviews')),
    content: contentSource(starter, null),
    projects: {
      catalog,
      content: contentSource,
      packages: (id) => new PackageStore(join(userData, 'projects', id, 'packages')),
      reviews: (id) => new ReviewStore(join(userData, 'projects', id, 'reviews')),
    },
    runtime: runtime(),
    appVersion: app.getVersion(),
    versions: { electron: process.versions.electron, node: process.versions.node, chrome: process.versions.chrome },
    devSolveBug,
    devSkipOnboarding,
    devShowProjects,
    devCatalog: app.isPackaged ? undefined : devCatalogOptions(localCatalogFile(userData), catalog),
    autoOnboarding,
    onChange: (snapshot: Snapshot) => window?.webContents.send(channelName('snapshot'), snapshot),
    logLine: (line) => log.info(line),
    diagnostics: {
      os: { platform: process.platform, release: release(), version: osVersion(), arch: process.arch },
      home,
      recentLog: () => recentLines(logFile),
      openLogsFolder: () => openLogsFolder(logsDir, isWsl() ? openWithWindowsExplorer : (path) => shell.openPath(path)),
    },
  });
  const language = app.getLocale().toLowerCase().startsWith('pt') ? 'pt' : 'en';
  await game.init(language);
  // A newer catalog (new or hidden projects) applies without a new build of the app.
  void game.refreshCatalog();

  registerIpc(game, devRendererUrl ? new URL(devRendererUrl).origin : null, openUrl);
  if (devTools) {
    await loadReactDevTools();
  }
  window = createWindow();

  app.on('second-instance', () => {
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app.on('window-all-closed', () => app.quit());
  // Closing the app stops QA and the workspace container; the quit waits for it (20 s at most).
  let shuttingDown = false;
  app.on('before-quit', (event) => {
    if (shuttingDown) return;
    shuttingDown = true;
    event.preventDefault();
    void game
      .shutdown()
      .catch(() => {})
      .finally(async () => {
        if (isE2E) {
          // The e2e tests read how the quit went (the fake runtime counts the shutdowns).
          const fake = (globalThis as { bugDetectiveFake?: { shutdownCalls: number } }).bugDetectiveFake;
          await writeFile(join(userData, 'shutdown.json'), JSON.stringify({ shutdownCalls: fake?.shutdownCalls ?? null })).catch(() => {});
        }
        app.quit();
      });
  });

  // Detects Docker stopping or starting during a session (shown as a banner in the UI).
  // A check can take longer than the interval (docker version waits up to 15 s): never two at once.
  const poll = skipWhileRunning(() => game.refreshDockerState());
  void poll().then(() => game.checkPrerequisites().catch(() => {}));
  setInterval(() => void poll(), isE2E ? 1000 : 10_000);
  // Leftover QA containers from a crash are removed once Docker answers.
  void game.cleanupLeftovers();
}

// A failed start (a game saved by a newer version, an invalid catalog.local.json, ...) must not
// leave the process running without a window: say why, then quit.
main().catch((error: unknown) => {
  const { title, body } = startupErrorText(app.getLocale(), error);
  if (isE2E) {
    // Nobody is there to close a dialog: the e2e tests read the reason from stderr.
    console.error(`${title}: ${body}`);
  } else {
    dialog.showErrorBox(title, body);
  }
  app.quit();
});
