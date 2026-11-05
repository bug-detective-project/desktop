// Runs the real NSIS installer end to end: installs it silently, opens the app, updates over it and
// uninstalls it, then checks what each step left on the computer. An uninstall deletes the game
// state and the Docker data of the app, so this runs only on a disposable runner of GitHub.
//
//   node tools/check-installer.mjs (the CI job "installer", after pnpm run dist:win)
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve, win32 } from 'node:path';

/** A volume carrying the app's label, standing for the player's code. */
const VOLUME = 'bugdetective-installer-check';
const UNINSTALL_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
const WAIT_MS = 180_000;

/** Why this machine must not run the check, or null when it is a disposable one. */
export function refusal(env, platform) {
  const hosted = env.CI === 'true' && env.GITHUB_ACTIONS === 'true' && env.RUNNER_ENVIRONMENT === 'github-hosted';
  return hosted && platform === 'win32' ? null : 'Refusing to run: uninstalling deletes the game state and Docker data, so this runs only on a GitHub-hosted Windows runner.';
}

/** Where a per-user install puts the app, its data and its shortcuts. */
export function installedPaths(env) {
  const folder = win32.join(env.LOCALAPPDATA, 'Programs', 'Bug Detective');
  return {
    exe: win32.join(folder, 'Bug Detective.exe'),
    uninstaller: win32.join(folder, 'Uninstall Bug Detective.exe'),
    removeDockerData: win32.join(folder, 'resources', 'remove-docker-data.ps1'),
    data: win32.join(env.APPDATA, 'Bug Detective'),
    shortcuts: [win32.join(env.USERPROFILE, 'Desktop', 'Bug Detective.lnk'), win32.join(env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Bug Detective.lnk')],
  };
}

const say = (line) => console.log(line);

function check(condition, message) {
  if (!condition) throw new Error(message);
  say(`ok   ${message}`);
}

function run(command, args) {
  return spawnSync(command, args, { encoding: 'utf8', timeout: WAIT_MS });
}

async function waitFor(condition, what) {
  const deadline = Date.now() + WAIT_MS;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for: ${what}`);
    await new Promise((done) => setTimeout(done, 1000));
  }
}

const volumeExists = () => run('docker', ['volume', 'inspect', VOLUME]).status === 0;
const registered = () => run('reg', ['query', UNINSTALL_KEY, '/s', '/f', 'Bug Detective', '/d']).stdout?.includes('Bug Detective');

function install(setup) {
  const result = run(setup, ['/S']);
  if (result.status !== 0) throw new Error(`The installer exited with ${result.status}: ${result.error?.message ?? result.stderr}`);
}

/** The app has fuses Playwright cannot drive: it must start, stay up and write its log. */
async function openApp(paths) {
  let exited = null;
  const app = spawn(paths.exe, [], { stdio: 'ignore' });
  app.once('exit', (code) => {
    exited = code ?? 'a signal';
  });
  const logs = join(paths.data, 'logs');
  await waitFor(() => exited !== null || (existsSync(logs) && readdirSync(logs).length > 0), 'the log of the app');
  await new Promise((done) => setTimeout(done, 10_000));
  check(exited === null, `the app starts and stays open${exited === null ? '' : ` (exited with ${exited})`}`);
  run('taskkill', ['/IM', 'Bug Detective.exe', '/F', '/T']);
  await waitFor(() => exited !== null, 'the app to close');
}

async function main() {
  const why = refusal(process.env, process.platform);
  if (why) {
    console.error(why);
    process.exit(1);
  }
  const paths = installedPaths(process.env);
  const dist = resolve(import.meta.dirname, '..', 'dist');
  const installer = readdirSync(dist).find((name) => /^Bug-Detective-Setup-.*\.exe$/.test(name));
  if (!installer) throw new Error(`No installer in ${dist}: run pnpm run dist:win first`);
  const setup = join(dist, installer);

  const created = run('docker', ['volume', 'create', '--label', 'bugdetective.role=workspace', VOLUME]);
  if (created.status !== 0) throw new Error(`The runner's Docker cannot create a volume: ${created.error?.message ?? created.stderr}`);

  say(`Installing ${installer}`);
  install(setup);
  await waitFor(() => existsSync(paths.exe), 'the installed app');
  check(existsSync(paths.exe), 'the app is installed in the per-user folder');
  check(existsSync(paths.uninstaller), 'the uninstaller is installed');
  check(existsSync(paths.removeDockerData), 'the Docker cleanup script is installed');
  check(paths.shortcuts.every((file) => existsSync(file)), 'the desktop and Start menu shortcuts exist');
  check(registered(), 'Windows lists the app under installed programs');

  await openApp(paths);
  check(existsSync(paths.data), 'the app created its data folder');

  say('Updating over the installed app');
  install(setup);
  await waitFor(() => existsSync(paths.exe), 'the updated app');
  check(volumeExists(), "an update keeps the player's code in Docker");
  check(existsSync(paths.data), 'an update keeps the game state');

  say('Uninstalling');
  const removed = run(paths.uninstaller, ['/S']);
  if (removed.status !== 0) throw new Error(`The uninstaller exited with ${removed.status}: ${removed.stderr}`);
  // The uninstaller copies itself to a temporary folder and goes on from there.
  await waitFor(() => !existsSync(paths.exe) && !volumeExists(), 'the uninstaller to finish');
  check(!existsSync(paths.exe), 'the app is removed');
  check(!volumeExists(), "the app's Docker data is removed");
  await waitFor(() => !existsSync(paths.data), 'the game state to go');
  check(!existsSync(paths.data), 'the game state is removed');
  check(paths.shortcuts.every((file) => !existsSync(file)), 'the shortcuts are removed');
  check(!registered(), 'Windows no longer lists the app');
  say('The installer installs, updates and uninstalls.');
}

if (resolve(process.argv[1] ?? '') === import.meta.filename) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
