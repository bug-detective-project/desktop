/** Electron main process: window, security settings, services and IPC. */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { app, BrowserWindow, dialog, screen, session, shell } from 'electron';
import { z } from 'zod';
import icon from '../../resources/icon.png?asset';
import type { Snapshot } from '../shared/api.ts';
import { attachDevToolsShortcuts, loadReactDevTools } from './devtools.ts';
import { FakeRuntime } from './fake-runtime.ts';
import { Game } from './game.ts';
import { channelName, registerIpc } from './ipc.ts';
import { currentPlatform } from './platform/index.ts';
import type { Platform } from './platform/types.ts';
import { DockerRuntime } from './runtime.ts';
import type { GameRuntime } from './runtime.ts';
import { LocalContentSource } from './services/content/local.ts';
import { contentSourceFor, parseLocalProjects, parseProjectsCatalog, starterProject, withLocalProjects } from './services/projects.ts';
import projectsJson from '../../content/projects.json' with { type: 'json' };
import type { ContentSource } from './services/content/source.ts';
import { PackageStore } from './services/content/store.ts';
import { skipWhileRunning } from './services/poll.ts';
import { runCommand } from './services/process.ts';
import { ReviewStore } from './services/review/store.ts';
import { StateStore } from './services/state.ts';

// Tests and the "clean profile" checks can point the app at another data folder.
if (process.env.BUGDETECTIVE_USER_DATA) {
  app.setPath('userData', resolve(process.env.BUGDETECTIVE_USER_DATA));
}

const isE2E = process.env.BUGDETECTIVE_E2E === '1' && !app.isPackaged;
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

const contentConfigSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local'), qaDir: z.string() }),
  z.object({ kind: z.literal('github'), repository: z.string(), baseUrl: z.string().optional() }),
]);

/** The projects the app uses (content/projects.json, bundled into the app, plus local-only ones in development). */
const catalog = withLocalProjects(parseProjectsCatalog(projectsJson), localProjectDirs(), app.isPackaged);
/** The project being played: the starter one, until switching projects exists. */
const project = starterProject(catalog);

function projectId(): string {
  return project.id;
}

/**
 * Development only: desktop/projects.local.json may point projects at local qa folders
 * ({ "supportdesk": "../supportdesk-qa" }); without it, development downloads from GitHub too.
 */
function localProjectDirs(): Record<string, string> {
  const file = join(appRoot, 'projects.local.json');
  if (app.isPackaged || !existsSync(file)) {
    return {};
  }
  return parseLocalProjects(JSON.parse(readFileSync(file, 'utf8')));
}

/**
 * Each project's content comes from its repository (content/projects.json), cached per project, or
 * from a local qa folder in development (projects.local.json). For the starter project,
 * %APPDATA%\Bug Detective\content-source.json overrides both (the e2e tests use it).
 */
function contentSource(id: string): ContentSource {
  const entry = catalog.projects.find((item) => item.id === id)!;
  const configFile = join(app.getPath('userData'), 'content-source.json');
  if (entry.starter && existsSync(configFile)) {
    const config = contentConfigSchema.parse(JSON.parse(readFileSync(configFile, 'utf8')));
    if (config.kind === 'local') {
      return new LocalContentSource({ qaDir: config.qaDir, runner: runCommand });
    }
    return contentSourceFor({ ...entry, repository: config.repository }, { packaged: true, localDirs: {}, baseDir: appRoot, userData: app.getPath('userData'), baseUrl: config.baseUrl }, console.log);
  }
  return contentSourceFor(entry, { packaged: app.isPackaged, localDirs: localProjectDirs(), baseDir: appRoot, userData: app.getPath('userData') }, console.log);
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
  // No permission (camera, notifications, ...) is ever needed.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);

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
  const game = new Game({
    store: new StateStore(userData),
    // Downloaded packages and reviews belong to the project they came from.
    packages: new PackageStore(join(userData, 'projects', projectId(), 'packages')),
    reviews: new ReviewStore(join(userData, 'projects', projectId(), 'reviews')),
    content: contentSource(projectId()),
    projects: {
      catalog: catalog.projects,
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
    autoOnboarding,
    onChange: (snapshot: Snapshot) => window?.webContents.send(channelName('snapshot'), snapshot),
  });
  const language = app.getLocale().toLowerCase().startsWith('pt') ? 'pt' : 'en';
  await game.init(language);

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

  // Detects Docker stopping or starting during a session (shown as a banner in the UI).
  // A check can take longer than the interval (docker version waits up to 15 s): never two at once.
  const poll = skipWhileRunning(() => game.refreshDockerState());
  void poll().then(() => game.checkPrerequisites().catch(() => {}));
  setInterval(() => void poll(), isE2E ? 1000 : 10_000);
  // Leftover QA containers from a crash are removed once Docker answers.
  void game.cleanupLeftovers();
}

// A failed start (a game saved by a newer version, an invalid content-source.json, ...) must not
// leave the process running without a window: say why, then quit.
main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (isE2E) {
    // Nobody is there to close a dialog: the e2e tests read the reason from stderr.
    console.error(`Bug Detective could not start: ${message}`);
  } else {
    dialog.showErrorBox('Bug Detective could not start', message);
  }
  app.quit();
});
