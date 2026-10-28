# Bug Detective (desktop)

An offline-first desktop game where developers practice debugging. The player joins Lanternfish Labs, gets SupportDesk tickets on a Kanban board, fixes them in their own VS Code (attached to a Docker container), and goes through QA and a code review. Runs on Windows (installer) and on Linux, including directly inside WSL 2 (development mode; no Linux package yet).

- Electron 45 (Node.js 24.22 inside Electron) + React 19 + TypeScript 7 + Vite 8 via electron-vite 6
- Tailwind CSS 4 (`@tailwindcss/vite`, shadcn-style tokens in `src/renderer/src/styles.css`; rules in [docs/design-system.md](docs/design-system.md)), Inter and JetBrains Mono bundled locally
- i18next (English and Brazilian Portuguese)
- electron-builder 26 (NSIS installer)
- Build tooling: Node.js 26.12.1 (`.nvmrc`), the same version as SupportDesk and the Docker images

## Layout

```
src/main/              Electron main process
  index.ts             window, security settings, content source selection
  ipc.ts               IPC handlers; every input validated with zod
  game.ts              game controller (Kanban rules + runtime), independent of Electron
  runtime.ts           GameRuntime interface and DockerRuntime
  fake-runtime.ts      in-memory runtime for the e2e tests (development builds only)
  devtools.ts          Chrome DevTools shortcuts and React Developer Tools (development builds only)
  services/            prerequisites, docker, workspace, content/, qa, vscode, state, backup, process,
                       review/ (review configuration, review data store, commit messages and settings)
  platform/            OS-specific code: types.ts (interface), windows.ts, linux.ts (Linux and WSL 2)
src/preload/           the typed window.bugDetective bridge
src/renderer/          React UI (Tailwind): app header + Dashboard, Board, Settings, ticket panel, code review
docs/                  design-system.md (tokens, components and screen layout)
resources/icon.png     app icon (executable, installer, window); the header logo is src/renderer/src/assets/logo.png
src/shared/            types, the Kanban state machine, QA message selection
docker/workspace/      the player's workspace image (+ the port forwarder)
docker/qa/             the QA image (Node 26 + Playwright Chromium + the SupportDesk QA CLI)
content/               company story and manager messages (story.en.json, story.pt.json), and
                       projects/<projectId>/review.json (each learning project's review configuration)
tools/                 build-stage-packages.ts, prepare-resources.ts, sync-windows.sh, win.sh
tools/lint/            the isolated ESLint toolchain (config.js, its own package.json)
.husky/                git hooks (pre-commit, pre-push)
test/unit|integration|e2e|manual
```

## Requirements

- Windows 10/11 with WSL 2 and Docker Desktop (WSL 2 backend)
- VS Code (the app installs the Dev Containers extension)
- For development: Node.js 26.12.1 and pnpm 12.15.0 on Windows; optionally the same in WSL for unit tests. Install pnpm with `npm install -g pnpm@12.15.0` (`packageManager` and `engines` in `package.json` pin it; Node.js 26 no longer ships Corepack)
- `../supportdesk-private` next to this folder (the SupportDesk repository with the `stage-N` branches)

## Development on Windows

```powershell
pnpm install --frozen-lockfile
pnpm run electron:install  # downloads the Electron binary (Electron 45 does it lazily)
pnpm run dev               # prepares build/docker and build/stage-packages, then starts Electron
```

`pnpm run dev` and `pnpm run build` first run:

- `tools/prepare-resources.ts`: copies `docker/` and the QA CLI (`../supportdesk-private/qa` without `stages/`) into `build/docker/` and writes content-addressed image tags to `build/docker/images.json`;
- `tools/build-stage-packages.ts`: builds `build/stage-packages/` (one zip per stage + `manifest.json`), which the local content source verifies against.

## Inspecting the UI (Chrome and React DevTools)

Development builds (`pnpm run dev`, or `out/` started without packaging) have:

- **Chrome DevTools**: `F12` or `Ctrl+Shift+I` (`Cmd+Option+I` on macOS) toggles them: Elements (DOM and Tailwind classes, computed styles), Console, Network, Sources, Performance. `BUGDETECTIVE_DEVTOOLS=1` opens them in their own window at start (`BUGDETECTIVE_DEVTOOLS=1 pnpm run dev` in WSL, `$env:BUGDETECTIVE_DEVTOOLS=1; pnpm run dev` in PowerShell).
- **React Developer Tools**: the **Components** tab (component tree, props, state, hooks; select a component to jump to its DOM node) and **Profiler**, inside the same DevTools window. `src/main/devtools.ts` downloads the extension from the Chrome Web Store on the first start (internet needed once; cached in `<userData>/extensions`) and loads it before the window opens. Offline without a cached copy, the app starts without it and logs a warning.

Neither is set up in the packaged app or in the e2e tests (`BUGDETECTIVE_E2E=1`); the download code is excluded from the installer (`electron-builder.yml`).

## Running directly in WSL 2 (Linux)

The app also runs as a Linux app inside WSL 2, shown on the Windows desktop through WSLg. Requirements:

- Windows 11 (or Windows 10 with WSLg) and Node.js 26.12.1 in the distro (`nvm use`), with pnpm 12.15.0 (`npm install -g pnpm@12.15.0`).
- Docker Desktop with **WSL integration enabled for this distro** (Settings → Resources → WSL integration), so `docker` works inside WSL. Docker Engine installed in the distro also works.
- Electron's system libraries, once: `sudo apt-get install -y libgtk-3-0 libasound2 libnss3 libgbm1 libxss1`.
- VS Code on Windows with the Dev Containers extension (the app installs it).

```sh
cd desktop
nvm use                    # 26.12.1
pnpm install --frozen-lockfile
pnpm run electron:install  # downloads the Linux Electron binary
pnpm run dev
```

How the Linux platform module (`src/main/platform/linux.ts`) behaves inside WSL:

- Docker: the `docker` CLI from the WSL integration, with Linux paths (game data in `~/.config/Bug Detective`). The Windows `docker` shim on the PATH is ignored. While Docker Desktop is stopped, the CLI disappears from WSL; "Start Docker Desktop" starts the Windows app through interop.
- VS Code: the Windows `Code.exe` with its CLI entry point, through interop (`ELECTRON_RUN_AS_NODE` is passed with `WSLENV`). It attaches to the same container, because WSL and Windows share Docker Desktop's engine. The VS Code Server remote CLI (`~/.vscode-server/.../remote-cli/code`) is never used.
- "Open app in browser" and help links open the Windows default browser (`explorer.exe <url>`). Published ports answer both in WSL and on Windows.
- The WSL 2 check is read from the kernel (`/proc/version`).

On plain Linux (not WSL), the same module uses Docker Engine, VS Code for Linux (`code`) and the default browser; the WSL check is skipped. That path is unit-tested only.

Do not start the app from a process that sets `ELECTRON_RUN_AS_NODE=1` (some editor extension hosts do): Electron would run as plain Node and fail to load `electron`. Normal terminals, including VS Code's integrated terminal, are fine.

Linux and Windows share the same Docker images (the tags are content hashes) and the same Docker volumes, so a game started on one side continues on the other only if the data folder is shared too; by default each side has its own state (`%APPDATA%` vs `~/.config`).

## Windows development from WSL 2

To run the Windows app (and build the installer) from a WSL terminal, Electron, the e2e tests and electron-builder run with Windows Node.js on a Windows copy of the code. `node_modules` is never shared between the two sides.

```sh
# Linux side: unit tests (and SupportDesk/QA work)
nvm use            # 26.12.1
pnpm install --frozen-lockfile
pnpm test

# Windows side: sync to C:\Users\<you>\bugdetective-dev, then run there with Windows Node
tools/sync-windows.sh
tools/win.sh pnpm install --frozen-lockfile
tools/win.sh pnpm run electron:install
tools/win.sh pnpm run dev
tools/win.sh pnpm run test:e2e
tools/win.sh pnpm run dist:win
```

`tools/win.sh` expects a Windows Node.js 26.12.1 in `%USERPROFILE%\bugdetective-dev\tools\node-v26.12.1-win-x64` (the official portable zip), or set `BUGDETECTIVE_WIN_NODE`. Install pnpm there once with `tools/win.sh npm install -g pnpm@12.15.0` (it lands next to `node.exe`). Run `tools/sync-windows.sh` after every change.

Docker is shared: `docker.exe` on Windows and the WSL integration talk to the same engine.

## Tests

| Command | Where | What |
| --- | --- | --- |
| `pnpm test` | WSL or Windows | Builds `build/stage-packages/` first (`pretest`, needs `../supportdesk-private` with its `stage-N` branches), then Vitest unit tests: Kanban rules, state and migrations, QA result parsing and messages, checksums, content sources (local git repo and a mock GitHub server), backup manifests, Windows detection, the game controller, the code review (review configuration and path matching, comparison parsing, review data, the checkout and return state machine with crash recovery) |
| `pnpm run test:integration` | Windows or Linux/WSL 2 + Docker | Real Docker: unlock stage 1, QA on the buggy stage (Gate 2 fails), infinite-loop timeout, `reference.patch` applied in the workspace container (both gates pass), next stage, export/delete/restore, interrupted QA (`qa-flow`, `bugdetective-test-*` resources); the code review: approved snapshot from an uncommitted fix, review branch and its recreation, checkout and return with uncommitted/untracked/excluded files, edits on the review branch, crash recovery, a Done review, the return before QA, export/restore and a new game (`review-flow`, `bugdetective-review-test-*` resources). Never touches the player's resources. Run `pnpm run build` first. |
| `pnpm run test:e2e` | Windows or Linux/WSL 2 (WSLg) | Playwright for Electron with the fake runtime: first-run checklist, Docker banner, Kanban drag rules, ticket panel, code review (layout, file list, split diff, whitespace toggle, identical solutions, review banner, button states), language, restart, Settings tabs (versions, disk usage, QA limit, last export, locked actions) |
| `pnpm exec playwright test --config playwright.manual.config.ts` | Windows or Linux/WSL 2, + Docker + VS Code | The full game loop through the real UI (all four tickets, VS Code attach, restart during QA, export/restore). Opens VS Code windows. |

## Lint and git hooks

ESLint 10 with typescript-eslint, plus the React Hooks and React Refresh rules for the renderer. The toolchain lives in `tools/lint/` with its own `package.json`, because typescript-eslint needs the TypeScript JavaScript API and TypeScript 7 (the app's compiler) no longer ships it: the lint package pins TypeScript 6.0 for the parser only. It is a package of the pnpm workspace (`pnpm-workspace.yaml`), so `pnpm install` in `desktop/` installs it too, and `eslint.config.js` re-exports `tools/lint/config.js`.

```sh
pnpm run lint       # check
pnpm run lint:fix   # fix what can be fixed
```

Husky installs two hooks in this repository (`prepare` runs `husky`, which points `core.hooksPath` at `.husky/_`):

| Hook | Runs | Blocks when |
| --- | --- | --- |
| `pre-commit` | lint-staged: `eslint --fix` on the staged `.ts/.tsx/.js/.mjs/.cjs` files, fixes re-staged | an error remains after `--fix` (warnings pass) |
| `pre-push` | `pnpm run verify:push`: typecheck, unit tests, integration tests with real Docker (about 2–3 minutes) | anything fails, including Docker not running |

The hooks need Node.js 26 on the `PATH` of the shell that runs git. If you commit from an editor whose git does not load nvm, create `~/.config/husky/init.sh` with `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"`. To skip the hooks once (not recommended): `git commit --no-verify` / `git push --no-verify`. The VS Code ESLint extension must use the toolchain in `tools/lint`: set `"eslint.nodePath": "tools/lint/node_modules"` in the workspace settings (`"desktop/tools/lint/node_modules"` when the workspace is the parent folder).

## Installer

```powershell
pnpm run dist:win    # dist\Bug-Detective-Setup-<version>.exe (not signed)
```

The installer is per-user (no admin rights), lets the player choose the folder, and adds Start menu and desktop shortcuts. The packaged app carries `resources/docker/` (Dockerfiles, the QA CLI, `images.json`); images are built on the player's machine the first time, with the player's consent.

## Configuration

| | |
| --- | --- |
| State | `%APPDATA%\Bug Detective\state.json` (versioned JSON, atomic writes, migrations in `services/state.ts`) |
| Stage packages | `%APPDATA%\Bug Detective\packages\stage-N.zip` and `stage-N\` (outside the Docker volume) |
| Review data | `%APPDATA%\Bug Detective\reviews\ticket-N\` (`snapshot.zip`, `reference.zip`, `review.json`) for every ticket that passed QA; included in exports |
| Review configuration | `bugDetective.project` in `package.json` picks `content/projects/<projectId>/review.json`: `{ "exclude": ["<glob>", …], "includeTests": true }`. Built-in excludes always apply on top (dependencies, lockfiles, `*.db`, `*.sqlite*`, `dist/`, `build/`, `coverage/`, `.env*`, logs). |
| Content source | Development: the local SupportDesk checkout (`BUGDETECTIVE_SUPPORTDESK`, `BUGDETECTIVE_MANIFEST` override the paths). Installed app: GitHub, `bugDetective.contentRepository` / `contentRelease` in `package.json`. `%APPDATA%\Bug Detective\content-source.json` overrides both: `{ "kind": "local", "repoPath": "...", "manifestPath": "..." }` or `{ "kind": "github", "repository": "owner/name", "release": "latest" }` |
| Data folder | `BUGDETECTIVE_USER_DATA` replaces `%APPDATA%\Bug Detective` (tests, clean-profile checks) |
| Docker resources | Volumes `bugdetective-workspace` (the player's repository), `bugdetective-vscode-server`, `bugdetective-qa-cache` (dependency cache), `bugdetective-qa-input` (the copy of the workspace the last QA run tested); container `bugdetective-workspace`; images `bugdetective-workspace:<hash>`, `bugdetective-qa:<hash>`; QA containers `bugdetective-qa-*`. All labeled `bugdetective.role`. |

## Publishing stages (GitHub)

Each game project has two repositories in the `bug-detective-project` organization: a private one with the source, the QA suite and every branch (`supportdesk-private`, remote `origin` in `../supportdesk-private`) and a public one with only the `stage-N` branches and the content releases (`supportdesk`, remote `public`). The installed app reads the public one (`bugDetective.contentRepository`).

Nothing is published automatically. To publish a content release:

1. Push every branch to the private repository (`git push origin --all`) and the `stage-1` … `stage-4` branches to the public one (`git push public stage-1 stage-2 stage-3 stage-4`). Keep `qa/` off the stage branches.
2. `pnpm run build:stages -- --version 1.0.0` (or `node tools/build-stage-packages.ts --repo ../supportdesk-private --version 1.0.0`).
3. Create a GitHub Release on the public repository and upload every file of `build/stage-packages/`: `gh release create v1.0.0 -R bug-detective-project/supportdesk --target stage-1 build/stage-packages/*`.
4. The app downloads `releases/latest/download/manifest.json`, then the package of the unlocked stage and `archive/refs/heads/stage-N.zip`. It checks the package's SHA-256 and the stage files' digest against the manifest before using anything. If a branch moves after the release, its digest no longer matches: publish a new release.

## How the workspace and VS Code fit together

- The workspace container runs `bugdetective-workspace:<hash>` (`node:26.12.1-bookworm`, the same base as SupportDesk's dev container, user `node`) with the `bugdetective-workspace` volume at `/workspaces/supportdesk`. Its ports are published on `127.0.0.1` only: the container's 15173 (a small forwarder to Vite on `localhost:5173`, which only listens on localhost) and 3001 (the API). Free host ports are chosen when 5173/3001 are taken.
- Unlocking a stage imports the stage files as a commit on the internal branch `bugdetective/stages` (tagged `stage-N`; an existing tag is reused only if it holds the same snapshot), then creates `player/ticket-N` from it. Uncommitted work from the previous ticket is stashed; earlier `player/*` branches of the same game are never changed.
- The repository records its game (`git config bugdetective.game`, the state's `createdAt`). When another game unlocks a stage (a new playthrough on the same computer, or **Settings → New game**), the old `player/*` branches are renamed to `archive/<time>/player/ticket-N` and uncommitted work is stashed. A restore marks the repository with the restored game.
- Starting a ticket (To Do → In Progress, once per ticket) forces `player/ticket-N` back to `stage-N`: uncommitted changes, untracked files and extra commits are discarded (ignored files such as `node_modules` stay) and `npm run db:reset` reseeds the database. Returning from QA keeps the player's work. This step needs Docker.
- **Open in VS Code** runs `Code.exe <commit>\resources\app\out\cli.js --new-window --folder-uri vscode-remote://attached-container+<hex of {"containerName":"/bugdetective-workspace"}>/workspaces/supportdesk` with `ELECTRON_RUN_AS_NODE=1`, which is exactly what `bin\code.cmd` does, without going through `cmd.exe`.
- QA runs in a new container per attempt, with `--network none`, the stage package bind-mounted read-only, and dependencies from the cache volume. The workspace (without `.git` and `node_modules`) is first copied into the `bugdetective-qa-input` volume, which QA mounts read-only; edits made while QA runs do not change what it tests. The containers are always removed.
- **Code review.** When QA passes, the files QA tested (from `bugdetective-qa-input`, minus the review excludes) become the approved snapshot: stored in the app data folder and as a commit tagged `qa-approved/ticket-N` that is on no player branch. The app also builds `review/ticket-N` with two commits on the stage commit, the reference (stage + `reference.patch`) then the approved snapshot, so the snapshot commit's diff is exactly "reference → your solution". Excluded paths keep the reference's version in both commits, and both carry a `.vscode/settings.json` with `"files.readonlyInclude": { "**": true }` (merged into the project's own settings). Commits use the approval date, so rebuilding from the stored data gives the same commits. The in-app comparison uses diffs computed by git at that moment (with and without whitespace), so it works with Docker stopped.
- **Open Review in VS Code** commits the player's uncommitted and untracked work on their branch as `Bug Detective: work in progress saved automatically` (excluded paths never included; no stash), records where to return in `state.json`, checks out `review/ticket-N` with a temporary `core.excludesFile` that hides excluded files from Source Control, and opens VS Code without `--new-window` (an open window on the workspace is reused). The Source Control Graph's top commit is the approved solution; opening it shows the multi-file diff. The return (the banner's "Back to my code", and automatically before QA, Open in VS Code, accepting the review, the next assignment, starting a ticket, a new game, export, restore, and on start after a crash) saves edits made on the review branch to `review-edits/ticket-N-<time>`, restores `core.excludesFile`, checks out the player's branch, undoes the temporary commit with a mixed reset and restores the index. Every step is written to the state first, so an interrupted switch is finished on the next start.

## Security

- `contextIsolation`, `sandbox` and no `nodeIntegration` in the renderer; the preload exposes one typed object; every IPC call is validated with zod and only accepted from the app's own page.
- A strict CSP (`default-src 'none'`, scripts, styles and fonts from `'self'` only); no remote content, navigation and new windows blocked, permission requests denied.
- External commands run with `spawn` and argument arrays only. The few shell scripts run inside containers are constants; data reaches them only as positional arguments.
- `shell.openExternal` only for the four help pages in `EXTERNAL_LINKS` and the workspace app on `http://127.0.0.1:<published port>/`.

## License

[PolyForm Noncommercial 1.0.0](LICENSE): free for noncommercial use; redistributions must keep the license and its `Required Notice:` line (the credit). Commercial use needs a separate license from the author.
