/**
 * Task 4.1 (loose-ends item 37): what the Dev Containers extension passes into the workspace
 * container when VS Code attaches, and which of it the app can turn off for its own container
 * only. Real Docker and VS Code (Windows, or Linux/WSL 2), the real SupportDesk content.
 *
 *   pnpm run test:real-runtime credentials-probe
 *
 * Three attach rounds against the real "bugdetective-workspace" container, each probed from
 * inside with `docker exec` (never printing a secret: credential answers are redacted):
 *   1. defaults;
 *   2. the per-container configuration file (nameConfigs/bugdetective-workspace.json) with
 *      `dev.containers.gitCredentialHelperConfigLocation: none` and `copyGitConfig: false`, and the
 *      same keys written into the container's machine settings (data/Machine/settings.json in the
 *      app's vscode-server volume): the attach setup reads that file, and the extension copies the
 *      configuration file's settings into it only once (.writeMachineSettingsMarker);
 *   3. no attach: what the container side can do on its own (GIT_CONFIG_SYSTEM and
 *      GIT_CONFIG_GLOBAL pointing at read-only files, what the workspace image could ship), so
 *      the extension's `git config … || true` writes fail and git never sees a helper.
 * Between rounds the container's git configuration is put back (the extension writes the helper
 * in /etc/gitconfig and ~/.gitconfig). The findings go to pr-gate/credentials-probe-<time>.md
 * and to the test's attachments. The named configuration file and the container are put back
 * the way they were.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { _electron as electron, expect, test } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { takeNextTicket } from '../e2e/fixtures.ts';
import { finishOnboarding } from './onboarding.ts';
import { workspaceDir } from '../../src/main/services/workspace.ts';

const root = resolve(import.meta.dirname, '..', '..');
const DOCKER = process.platform === 'win32' ? 'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe' : 'docker';
const CONTAINER = 'bugdetective-workspace';
const WORKSPACE = workspaceDir('supportdesk');
const SETTLE_MS = 60_000;

/** A shell line inside the container, as node, in the workspace; failures are part of the answer, not of the test. */
const inside = (script: string, user = 'node') => {
  try {
    return execFileSync(DOCKER, ['exec', '-u', user, '-w', WORKSPACE, CONTAINER, 'sh', '-c', script], { encoding: 'utf8', timeout: 60_000 }).trimEnd();
  } catch (error) {
    const failed = error as { stdout?: string; stderr?: string; status?: number };
    return `${(failed.stdout ?? '').trimEnd()}\n(exit ${failed.status}: ${(failed.stderr ?? '').trim().slice(0, 300)})`.trim();
  }
};
const log = (message: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);

/** The extension's per-container configuration folder of the user's VS Code. */
function nameConfigsDir(): string {
  const userDir =
    process.platform === 'win32'
      ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Code', 'User')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', 'Code', 'User')
        : join(homedir(), '.config', 'Code', 'User');
  return join(userDir, 'globalStorage', 'ms-vscode-remote.remote-containers', 'nameConfigs');
}

/** The newest Dev Containers log of the user's VS Code, filtered to the lines that tell what was forwarded. */
async function extensionLogLines(): Promise<string> {
  const logsDir = process.platform === 'win32' ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Code', 'logs') : join(homedir(), '.config', 'Code', 'logs');
  if (!existsSync(logsDir)) return '(no VS Code logs folder)';
  const files: { file: string; mtime: number }[] = [];
  const walk = async (dir: string, depth: number) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && depth < 5) await walk(path, depth + 1);
      else if (entry.isFile() && /remote-containers.*\.log$/i.test(path)) files.push({ file: path, mtime: (await stat(path)).mtimeMs });
    }
  };
  await walk(logsDir, 0);
  files.sort((a, b) => b.mtime - a.mtime);
  if (files.length === 0) return '(no Dev Containers log found)';
  const text = await readFile(files[0].file, 'utf8');
  const lines = text.split('\n').filter((line) => /ssh-agent|GPG|gpg|credential|gitconfig|Git config|Downloading|server|dotfiles|copy/i.test(line));
  return `${files[0].file}\n${lines.slice(-80).join('\n')}`;
}

async function open(userData: string): Promise<{ app: ElectronApplication; page: Page }> {
  const { ELECTRON_RUN_AS_NODE: _ignored, ...parentEnv } = process.env;
  const app = await electron.launch({ args: [root], env: { ...parentEnv, BUGDETECTIVE_USER_DATA: userData } });
  const page = await app.firstWindow();
  return { app, page };
}

async function installEnvironment(page: Page) {
  await page.getByTestId('nav-dashboard').click();
  const report = await page.evaluate(() => window.bugDetective.refreshEnvironment());
  if (!report.ready) {
    await page.getByTestId('install-environment').click();
    const modal = page.getByTestId('install-modal');
    await expect(modal.getByTestId('install-modal-close')).toBeVisible({ timeout: 30 * 60_000 });
    await expect(modal.getByTestId('install-modal-error')).toHaveCount(0);
    await modal.getByTestId('install-modal-close').click();
  }
}

/** How many vscode-server processes run in the container; 0 while the container is not there. */
function serverCount(): string {
  try {
    return execFileSync(DOCKER, ['exec', CONTAINER, 'sh', '-c', 'ps -eo args | grep -c "[v]scode-server" || true'], { encoding: 'utf8', timeout: 60_000 }).trim();
  } catch {
    return '0';
  }
}

/** The IPC socket of the live session, read from a vscode-server process (older sessions leave stale sockets in /tmp). */
const LIVE_SOCKET = String.raw`P=$(pgrep -f vscode-server | head -1); S=$([ -n "$P" ] && tr '\0' '\n' < /proc/$P/environ | sed -n 's/^REMOTE_CONTAINERS_IPC=//p')`;

/** Attaches VS Code to the workspace container (the app's own button) and waits for its server. */
async function attach(page: Page) {
  await page.getByTestId('nav-board').click();
  await page.getByTestId('card-1').click();
  // VS Code may be busy (starting, or a stale window closing): ask again every 90 s, up to three times.
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.getByTestId('open-vscode').click();
    // An error toast (VS Code not found, busy, workspace lost) explains a server that never comes.
    const toast = page.getByTestId('toast-error');
    if (await toast.isVisible({ timeout: 5000 }).catch(() => false)) {
      log(`attempt ${attempt}: the app showed "${(await toast.textContent())?.trim()}"`);
    }
    try {
      await expect.poll(serverCount, { timeout: 90_000 }).not.toBe('0');
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      log(`attempt ${attempt}: no VS Code server in the container yet, asking again`);
    }
  }
  await page.getByTestId('close-panel').click();
  log(`VS Code server running in the container; settling for ${SETTLE_MS / 1000} s`);
  await page.waitForTimeout(SETTLE_MS);
}

/**
 * Removes the workspace container (the volume with the code stays). Killing only the server, or
 * stopping and starting the same container, is not enough: the window reconnects in 5 s without
 * the attach setup (seen in the extension log). The next "Open in VS Code" makes the app create
 * the container again, and the window has to resolve it from scratch, reading the configuration.
 */
async function detach() {
  execFileSync(DOCKER, ['rm', '-f', CONTAINER], { encoding: 'utf8', timeout: 120_000 });
  await expect.poll(serverCount, { timeout: 60_000 }).toBe('0');
  // Give the window's reconnect loop time to notice the container is gone.
  await new Promise((resolve) => setTimeout(resolve, 20_000));
}

/** A fake git credential for github.com in the Windows Credential Manager (what the Git Credential Manager reads), so the helper channel has something to carry. */
const PER_CONTAINER_SETTINGS = {
  'dev.containers.gitCredentialHelperConfigLocation': 'none',
  'dev.containers.copyGitConfig': false,
  'dev.containers.dockerCredentialHelper': false,
  'dev.containers.githubCLILoginWithToken': false,
  'remote.containers.gitCredentialHelperConfigLocation': 'none',
  'remote.containers.copyGitConfig': false,
};

/** The machine settings file of the VS Code server inside the container (the app's vscode-server volume). */
const MACHINE_SETTINGS = '/home/node/.vscode-server/data/Machine/settings.json';

/** Merges the per-container keys into the machine settings inside the container; returns the previous text to restore. */
function seedMachineSettings(): string {
  const previous = inside(`cat ${MACHINE_SETTINGS} 2>/dev/null || echo "{}"`);
  const script = `const fs=require("fs");const f=${JSON.stringify(MACHINE_SETTINGS)};let j={};try{j=JSON.parse(fs.readFileSync(f,"utf8"))}catch{}Object.assign(j,${JSON.stringify(PER_CONTAINER_SETTINGS)});fs.mkdirSync(require("path").dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(j,null,"\t")+"\n");console.log("seeded")`;
  return `${previous}\n--- seed: ${inside(`node -e '${script.replace(/'/g, "'\\''")}'`)}`;
}
function restoreMachineSettings(previousText: string) {
  const text = previousText.split('\n--- seed:')[0];
  inside(`node -e 'require("fs").writeFileSync(${JSON.stringify(MACHINE_SETTINGS)}, process.argv[1])' ${JSON.stringify(text)}`);
}

const PROBE_CREDENTIAL = { target: 'git:https://github.com', user: 'bugdetective-probe' };
function storeProbeCredential(): string {
  if (process.platform !== 'win32') return '(not Windows: no fake credential stored)';
  const existing = execFileSync('cmdkey', ['/list'], { encoding: 'utf8' });
  if (existing.includes(PROBE_CREDENTIAL.target)) return '(a real git:https://github.com credential exists: left alone, not replaced)';
  execFileSync('cmdkey', [`/generic:${PROBE_CREDENTIAL.target}`, `/user:${PROBE_CREDENTIAL.user}`, '/pass:probe-secret-not-a-real-token'], { encoding: 'utf8' });
  return `(stored ${PROBE_CREDENTIAL.target} for ${PROBE_CREDENTIAL.user})`;
}
function removeProbeCredential(stored: string) {
  if (!stored.startsWith('(stored')) return;
  try {
    execFileSync('cmdkey', [`/delete:${PROBE_CREDENTIAL.target}`], { encoding: 'utf8' });
  } catch {
    // Already gone.
  }
}

const REDACT = String.raw`sed -E 's/^(password|oauth_refresh_token|token)=.*/\1=<redacted>/'`;
const FILL = String.raw`printf 'protocol=https\nhost=github.com\n\n' | GIT_TERMINAL_PROMPT=0 timeout 25 git credential fill 2>&1`;

/** The extension's helper is written in /etc/gitconfig (system) and ~/.gitconfig (global): both go before a round. */
function resetGitConfig() {
  // The container drops every capability: root cannot delete files in node's home, so each user removes its own.
  inside('git config --system --unset-all credential.helper 2>/dev/null; echo system-reset', 'root');
  inside('rm -f /home/node/.gitconfig /home/node/.config/git/config; echo user-reset');
}

/** Everything the report needs from inside the container, after an attach. */
function probe(): Record<string, string> {
  return {
    'credential.helper (git config --show-origin)': inside('git config --show-origin --get-all credential.helper || echo "(none)"'),
    '~/.gitconfig': inside('ls -la /home/node/.gitconfig 2>/dev/null; cat /home/node/.gitconfig 2>/dev/null || echo "(no ~/.gitconfig)"'),
    'git credential fill for github.com, plain docker exec (redacted)': inside(`${FILL} | ${REDACT}; echo "(exit $?)"`),
    'git credential fill for github.com with REMOTE_CONTAINERS_IPC, as a VS Code terminal has it (redacted)': inside(
      `${LIVE_SOCKET}; if [ -z "$S" ]; then echo "(no live IPC socket)"; else echo "socket: $S"; REMOTE_CONTAINERS_IPC=$S ${FILL} | ${REDACT}; echo "(exit $?)"; fi`,
    ),
    'the helper script called directly through the IPC socket, no git config involved (redacted)': inside(
      `${LIVE_SOCKET}; I=$(echo "$S" | sed -n 's|.*-ipc-\\(.*\\)\\.sock|\\1|p'); J=/tmp/vscode-remote-containers-$I.js; N=$(ls -d /home/node/.vscode-server/bin/*/node 2>/dev/null | head -1); if [ -z "$S" ] || [ ! -f "$J" ] || [ -z "$N" ]; then echo "(no live IPC socket, script or node: S=$S J=$J N=$N)"; else echo "script: $J"; printf 'protocol=https\\nhost=github.com\\n\\n' | REMOTE_CONTAINERS_IPC=$S timeout 25 $N $J git-credential-helper get 2>&1 | ${REDACT}; echo "(exit $?)"; fi`,
    ),
    'SSH_AUTH_SOCK in the container environment': inside('printenv SSH_AUTH_SOCK || echo "(not set)"'),
    'forwarded sockets in /tmp': inside('ls -la /tmp/vscode-*.sock /tmp/vscode-ssh-auth-* 2>/dev/null || echo "(none)"'),
    'environment of the vscode-server processes (selected variables)': inside(
      'for p in $(pgrep -f vscode-server | head -5); do tr "\\0" "\\n" < /proc/$p/environ 2>/dev/null | grep -E "^(SSH_AUTH_SOCK|REMOTE_CONTAINERS|REMOTE_CONTAINERS_IPC|REMOTE_CONTAINERS_DISPLAY_SOCK|DISPLAY|GPG_TTY|GIT_[A-Z_]+|GH_TOKEN|GITHUB_TOKEN)="; done | sort -u || echo "(none)"',
    ),
    'GPG, Docker and GitHub CLI material': inside('command -v gpg docker gh 2>/dev/null || echo "(no gpg/docker/gh binaries)"; ls -la /home/node/.gnupg /home/node/.docker /home/node/.config/gh 2>/dev/null || echo "(no ~/.gnupg, ~/.docker, ~/.config/gh)"; ls /usr/local/bin 2>/dev/null | grep -i credential || echo "(no credential helper binary in /usr/local/bin)"'),
    'known_hosts copied by the extension': inside('ls -la /home/node/.ssh 2>/dev/null || echo "(no ~/.ssh)"'),
    'internet from the container (VS Code update server)': inside('curl -sS -o /dev/null -m 10 -w "%{http_code}" https://update.code.visualstudio.com/api/update/server-linux-x64/stable/latest || echo " (no answer)"'),
    'VS Code server files in the container': inside('ls /home/node/.vscode-server 2>/dev/null | head; ls /home/node/.vscode-server/bin 2>/dev/null | head -3; ls /vscode 2>/dev/null | head -3 || true'),
  };
}

/** Round 3, run as root: the git writes the extension makes, against GIT_CONFIG_* pointing at read-only files. */
const MECHANICS = String.raw`
mkdir -p /etc/bugdetective
printf '[user]\n\tname = SupportDesk Developer\n\temail = developer@supportdesk.invalid\n' > /etc/bugdetective/gitconfig
chmod 444 /etc/bugdetective/gitconfig && chmod 555 /etc/bugdetective
echo '--- A. as node, GIT_CONFIG_GLOBAL=/etc/bugdetective/gitconfig (read-only): the global write of the extension'
su node -c 'export GIT_CONFIG_GLOBAL=/etc/bugdetective/gitconfig; git config --global --replace-all credential.helper probe-helper; echo exit=$?; git config --show-origin --get-all credential.helper || echo "(no helper visible to git)"; printf "[user]\n\tname = pedro\n" > /home/node/.gitconfig; echo name_seen_by_git=$(git config --get user.name)'
rm -f /home/node/.gitconfig
echo '--- B. as root, GIT_CONFIG_SYSTEM=/etc/bugdetective/gitconfig (read-only): the system write of the extension (root ignores modes)'
export GIT_CONFIG_SYSTEM=/etc/bugdetective/gitconfig; git config --system --replace-all credential.helper probe-helper; echo exit=$?; git config --show-origin --get-all credential.helper || echo '(no helper visible to git)'
unset GIT_CONFIG_SYSTEM
echo '--- C. as root, plain: /etc/gitconfig gets the helper, and GIT_CONFIG_NOSYSTEM=1 hides it from git (but not from a process that unsets the variable)'
git config --system --replace-all credential.helper probe-helper; echo exit=$?
su node -c 'GIT_CONFIG_NOSYSTEM=1 git config --show-origin --get-all credential.helper || echo "(no helper visible to git with GIT_CONFIG_NOSYSTEM=1)"; git config --show-origin --get-all credential.helper'
git config --system --unset-all credential.helper
echo '--- D. a root-owned, read-only ~/.gitconfig is replaced by the lock-and-rename of git config (the directory is the user'"'"'s)'
printf '[user]\n\tname = SupportDesk Developer\n' > /home/node/.gitconfig && chown root:root /home/node/.gitconfig && chmod 444 /home/node/.gitconfig
su node -c 'git config --global --replace-all credential.helper probe-helper; echo exit=$?; ls -la /home/node/.gitconfig'
rm -f /home/node/.gitconfig
chmod 755 /etc/bugdetective; rm -rf /etc/bugdetective
`;

function section(title: string, results: Record<string, string>): string {
  return [`## ${title}`, '', ...Object.entries(results).flatMap(([name, value]) => [`### ${name}`, '', '```', value || '(empty)', '```', ''])].join('\n');
}

test('what the Dev Containers extension passes into the workspace container, and how to turn it off', async () => {
  test.setTimeout(60 * 60_000);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const reportDir = join(root, 'pr-gate');
  await mkdir(reportDir, { recursive: true });
  const reportFile = join(reportDir, `credentials-probe-${stamp}.md`);
  const configDir = nameConfigsDir();
  const configFile = join(configDir, `${CONTAINER}.json`);
  const previousConfig = existsSync(configFile) ? await readFile(configFile, 'utf8') : null;
  const report: string[] = [
    `# Dev Containers credentials probe (${stamp})`,
    '',
    `Platform: ${process.platform}; container: ${CONTAINER}; per-container config: ${configFile}`,
    '',
    `Host git credential helpers (git config --show-origin): \n\`\`\`\n${(() => { try { return execFileSync('git', ['config', '--show-origin', '--get-all', 'credential.helper'], { encoding: 'utf8' }).trim(); } catch { return '(none)'; } })()}\n\`\`\``,
    '',
  ];

  const stored = storeProbeCredential();
  report.push(`Fake credential on the host: ${stored}`, '');
  const userData = await mkdtemp(join(tmpdir(), 'João Silva credentials-probe-'));
  const { app, page } = await open(userData);
  try {
    await expect(page.getByTestId('checklist')).toBeVisible();
    await expect(page.getByTestId('start-playing')).toBeEnabled({ timeout: 2 * 60_000 });
    await page.getByTestId('start-playing').click();
    await finishOnboarding(page);
    await installEnvironment(page);
    await page.getByTestId('nav-dashboard').click();
    await takeNextTicket(page, 'front');
    await expect(page.getByTestId('board')).toBeVisible({ timeout: 5 * 60_000 });
    await expect(page.getByTestId('card-1')).toHaveAttribute('data-status', 'todo', { timeout: 120_000 });
    await installEnvironment(page);
    log('ticket 1 unlocked; the container has never seen VS Code in this run');
    resetGitConfig();
    report.push(section('0. Before VS Code attaches', probe()));

    // Round 1: defaults.
    await attach(page);
    report.push(section('1. After the attach with the default settings', probe()));
    report.push(`### Dev Containers log (host)\n\n\`\`\`\n${await extensionLogLines()}\n\`\`\`\n`);
    log('round 1 (defaults) probed');

    // Round 2: the per-container configuration file turns the helper and the .gitconfig copy off.
    await mkdir(configDir, { recursive: true });
    await writeFile(
      configFile,
      `${JSON.stringify(
        {
          remoteEnv: { SSH_AUTH_SOCK: null },
          // Both spellings: the top-level `settings` the attach docs describe, and the devcontainer.json form the CLI merges.
          settings: PER_CONTAINER_SETTINGS,
          customizations: { vscode: { settings: PER_CONTAINER_SETTINGS } },
        },
        null,
        2,
      )}\n`,
    );
    resetGitConfig();
    const machineBefore = seedMachineSettings();
    report.push(`### Machine settings before the seed, and the seed\n\n\`\`\`\n${machineBefore}\n\`\`\`\n`);
    await detach();
    await attach(page);
    report.push(section('2. After the attach with nameConfigs/bugdetective-workspace.json (helper none, no .gitconfig copy, SSH_AUTH_SOCK unset)', probe()));
    report.push(`### Dev Containers log (host)\n\n\`\`\`\n${await extensionLogLines()}\n\`\`\`\n`);
    report.push(`### Machine settings after the attach\n\n\`\`\`\n${inside(`cat ${MACHINE_SETTINGS}`)}\n\`\`\`\n`);
    log('round 2 (per-container settings) probed');
    await rm(configFile, { force: true });
    restoreMachineSettings(machineBefore);

    // Round 3: no VS Code. What the image could ship so the extension's writes fail on their own.
    const mechanics = inside(MECHANICS, 'root');
    report.push(section('3. Without VS Code: GIT_CONFIG_SYSTEM and GIT_CONFIG_GLOBAL on read-only files (what the image could ship)', { 'git config writes as the extension does them': mechanics }));
    log('round 3 (container-side mechanics) probed');
  } finally {
    // The container, the host and the user's VS Code go back the way they were.
    removeProbeCredential(stored);
    resetGitConfig();
    if (previousConfig === null) await rm(configFile, { force: true });
    else await writeFile(configFile, previousConfig);
    // The app's own log of this run goes with the report (the data folder is deleted below).
    try {
      const logs = join(userData, 'logs');
      for (const name of await readdir(logs)) {
        report.push(`## App log: ${name}\n\n\`\`\`\n${(await readFile(join(logs, name), 'utf8')).split('\n').filter((line) => /VS Code|vscode|code|Code\.exe|error|Error/.test(line)).slice(-60).join('\n')}\n\`\`\`\n`);
      }
    } catch {
      report.push('(no app log)');
    }
    await writeFile(reportFile, `${report.join('\n')}\n`);
    await test.info().attach('credentials-probe.md', { path: reportFile, contentType: 'text/markdown' });
    log(`report: ${reportFile}`);
    await app.close().catch(() => {});
    await rm(userData, { recursive: true, force: true }).catch(() => {});
  }
});
