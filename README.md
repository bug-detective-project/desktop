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
docker/qa/             the base of the QA image (Node 26, plus Playwright Chromium when the QA CLI uses Playwright); the app adds the project's QA CLI at run time
content/               company.en.json, company.pt.json (the company, its people, and the texts shown before a
                       project is downloaded)
tools/                 prepare-resources.ts (Docker contexts and the bundled catalog), sync-windows.sh, win.sh
tools/lint/            the isolated ESLint toolchain (config.js, its own package.json)
.husky/                git hooks (pre-commit, pre-push)
test/unit|integration|e2e|real-runtime
.storybook/            Storybook (stories in src/renderer/src/**/*.stories.tsx, run as tests too)
renderer.config.ts     the renderer's Vite plugins and aliases, shared by the app and Storybook
```

## Requirements

To play (provisional until the real-runtime assertion settles, see the loose-ends plan):

- Windows 10 22H2 or Windows 11, 64-bit, with WSL 2
- 8 GB of RAM (16 GB recommended): the first-run checklist warns when the Docker engine (WSL 2's memory, set in `.wslconfig`) has less than 4 GB
- 10 GB free on the disk that holds Docker Desktop's data (`%LOCALAPPDATA%\Docker\wsl`): the download of the environment asks before going on with less, and a full disk while the game writes its state shows "The disk is full"
- Docker Desktop with the WSL 2 backend, in **Linux containers** mode (the checklist refuses Windows containers mode, with a link to switch back)
- VS Code (the app installs the Dev Containers extension)

For development:

- Node.js 26.12.1 and pnpm 12.15.0 on Windows; optionally the same in WSL for unit tests. Install pnpm with `npm install -g pnpm@12.15.0` (`packageManager` and `engines` in `package.json` pin it; Node.js 26 no longer ships Corepack)
- For editing game content only: `../supportdesk` and `../supportdesk-qa` next to this folder, a clone of the SupportDesk repository and its published `qa` branch (see below). The integration tests play their own example project (`test/fixtures/notes`), and the e2e tests use `../supportdesk-qa` when it is there, otherwise the SupportDesk publication pinned in `test/e2e/supportdesk-version.ts`, cloned once into `test/.cache/` (git-ignored; that first run needs internet). The unit tests play `test/fixtures/notes` too: no automated test reads `../supportdesk-qa` except the e2e ones, which fall back to the pinned publication. `pnpm run dev` and `pnpm run build` need no game project: the app downloads each project's content, QA CLI included, at run time.

## How to play

There are no published installers yet: they will come later, on GitHub Releases. Today the game runs from this repository. Besides the requirements above, you need Git, [Node.js 26.12.1](https://nodejs.org/) and pnpm 12.15.0 (`npm install -g pnpm@12.15.0`).

```sh
git clone https://github.com/bug-detective-project/desktop.git
cd desktop
pnpm install --frozen-lockfile
pnpm run start
```

To update, run `git pull`, `pnpm install --frozen-lockfile` and `pnpm run start`. `pnpm run start` builds the app and opens it as a player gets it: official catalog, no development tools. `pnpm run dev` is the one with the development tools (DevTools, `desktop/.env`, `catalog.local.json`, Settings → Development).

## Install from source

To build an installer on your own computer:

| System | Command | Result |
| --- | --- | --- |
| Windows | `pnpm run dist:win` | `dist\Bug-Detective-Setup-<version>.exe` |
| Linux (beta) | `pnpm run dist:linux` | `dist/Bug-Detective-<version>.AppImage` |

The CI builds the AppImage only when asked: run the `ci` workflow by hand with `build-appimage` on, and it stays as the `linux-appimage` artifact.

## Networks with a proxy

The app downloads the projects catalog and each project's content through Electron's `net.fetch`, so it follows the Windows proxy settings (including an authenticating proxy) and the Windows certificate store, exactly as a browser does: nothing to configure in the app. Two other programs download on their own and need their own settings:

- **Docker Desktop** pulls the base images and, when a ticket's dependencies are prepared, the npm packages: Settings → Resources → Proxies (manual proxy configuration, with the same address the browser uses).
- **VS Code** downloads its server and the Dev Containers extension: `http.proxy` in its settings (and `http.proxyStrictSSL` when the proxy inspects TLS with its own certificate).

The first-run checklist links to this section.

### Getting the SupportDesk repository

> **You never need to create a branch in a project listed in the projects catalog to run the app.** Every project is already published on GitHub (`main`, `qa`, the ticket branches and their tags), and the app downloads everything from there at run time. To run the tests or edit content, all you do is clone the repository and check out its existing `qa` branch with the two commands below. The ticket branches are created only by `npx bd build` when content authors change them.

SupportDesk is one public repository, `bug-detective-project/supportdesk`, with three kinds of branches:

| Branch | Holds |
| --- | --- |
| `main` | The SupportDesk app, with every bug fixed |
| `qa` | The QA suite and the game content at its root: the QA CLI, `tickets/<id>/` per ticket and the published `manifest.json` |
| `front-1` … `front-4` and `back-1` … `back-4` | One single-commit branch per ticket: `main` with that ticket's bug |

Clone it next to `desktop/` and check out the `qa` branch as a second folder (a git worktree), so the three folders are siblings:

```sh
cd ..    # the folder that holds desktop/
git clone git@github.com:bug-detective-project/supportdesk.git
git -C supportdesk worktree add ../supportdesk-qa qa
```

`worktree add … qa` checks out the published `qa` branch (git sets up the local `qa` to track `origin/qa`); it does not create a new branch on GitHub.

To develop with that local content, copy `desktop/catalog.local.example.json` to `desktop/catalog.local.json` (ignored by git, never packaged). Each project of the catalog can read a local qa folder or another qa ref (branch or tag), relative to `desktop/`:

```json
{ "projects": { "supportdesk": { "qaDir": "../supportdesk-qa" }, "other": { "qaRef": "qa-next" } } }
```

The same file can also point at another catalog: `"catalog": { "github": "bug-detective-project/catalog", "branch": "testar-x" }`, or `"catalog": { "file": "../catalog/projects.json" }`, where a project may name a `qaDir` instead of a `repository` (a project that is not on GitHub yet). The installed app never reads this file. Without it, `pnpm run dev` downloads the official catalog and every project from GitHub like the installed app.

In development, **Settings → Development** edits the same file: the catalog source (Official, GitHub with a repository and branch, or Local file) and, for each project of the catalog in use, Published, another qa ref or a local folder (**Choose…** opens the system dialog). **Apply** saves the file and reloads the catalog without a restart; **Restore defaults** deletes it. Changes apply from the next ticket; the open ticket keeps the version it was unlocked with. An invalid file is ignored (the app uses the official catalog and the tab shows why) until it is fixed or replaced. When the chosen catalog has not been downloaded or read yet (a GitHub branch while offline, a missing file), the tab says the app is using the copy bundled with the build. Overrides of projects that are not in the catalog in use stay in the file. While `BUGDETECTIVE_CATALOG_FILE` is set it wins, and the tab cannot apply. The e2e tests keep their `catalog.local.json` in their own data folder, never in `desktop/`. The automated tests pass their own catalog file with `BUGDETECTIVE_CATALOG_FILE` and read `../supportdesk-qa`, so they need the worktree.

The tools read the ticket branches from the clone as they are: the local branch when there is one, otherwise `origin/<id>`, which `git clone` already fetched. **Never create, rename or rebuild the ticket branches yourself:** they are the published ticket code, each a single commit, and only the content authors rebuild them (with `npx bd build` in `supportdesk-qa/`). If a tool says a ticket branch is missing, run `git -C ../supportdesk fetch origin`. If ticket branches were created by hand, reset them to the published ones:

```sh
cd ../supportdesk
git fetch origin
for id in front-1 front-2 front-3 front-4 back-1 back-2 back-3 back-4; do git branch -f --track $id origin/$id; done
```

## Development on Windows

```powershell
pnpm install --frozen-lockfile
pnpm run electron:install  # downloads the Electron binary (Electron 45 does it lazily)
pnpm run dev               # prepares build/docker, then starts Electron
```

`pnpm run dev` and `pnpm run build` first run:

- `tools/prepare-resources.ts`: copies `docker/` into `build/docker/` and writes `build/docker/images.json` (the workspace image tag and `qaBase`, the hash of `docker/qa/`). The QA image tag combines `qaBase` with the project's QA CLI, and its build context is assembled at run time in `%APPDATA%\Bug Detective\docker\qa-<hash>\`.

With a local qa folder, the content source builds the project manifest in memory from that folder and the ticket branches every time a ticket is unlocked, (`services/content/local-manifest.ts`), so development always uses the current content.

## Inspecting the UI (Chrome and React DevTools)

Development builds (`pnpm run dev`, or `out/` started without packaging) have:

- **Chrome DevTools**: `F12` or `Ctrl+Shift+I` (`Cmd+Option+I` on macOS) toggles them: Elements (DOM and Tailwind classes, computed styles), Console, Network, Sources, Performance. `BUGDETECTIVE_DEVTOOLS=1` opens them in their own window at start (`BUGDETECTIVE_DEVTOOLS=1 pnpm run dev` in WSL, `$env:BUGDETECTIVE_DEVTOOLS=1; pnpm run dev` in PowerShell).
- **React Developer Tools**: the **Components** tab (component tree, props, state, hooks; select a component to jump to its DOM node) and **Profiler**, inside the same DevTools window. `src/main/devtools.ts` downloads the extension from the Chrome Web Store on the first start (internet needed once; cached in `<userData>/extensions`) and loads it before the window opens. Offline without a cached copy, the app starts without it and logs a warning.

Neither is set up in the packaged app or in the e2e tests (`BUGDETECTIVE_E2E=1`); the download code is excluded from the installer (`electron-builder.yml`).

## Development settings (`.env`)

`pnpm run dev` loads `desktop/.env` at start; `pnpm run start` and the installer never do. Copy `.env.example` to `.env`; the file is git-ignored, never packaged, and ignored by the e2e tests (they pass their own variables). Variables already set in the environment win over the file.

| Variable | Effect |
| --- | --- |
| `BUGDETECTIVE_DEV_SHOW_PROJECTS=true` | Shows the **Projects** item in the header from the start, instead of after a project is done, to look at the screen and switch projects while developing. The packaged app never shows it early. |
| `BUGDETECTIVE_DEV_SOLVE_BUG_BUTTON=true` | Shows **Solve bug** on the board card in progress. A click puts the ticket's `reference.patch` into your code: every file the patch touches goes back to the stage version (your edits to those files are lost), then the patch is applied. Other files, the index and commits stay. Move the card to In QA afterwards as usual. The packaged app never shows it. |
| `BUGDETECTIVE_DEV_SKIP_ONBOARDING_BUTTON=true` | Shows **Skip onboarding** on Rafaela's welcome card and on every step of the onboarding. Skipping counts as finished: it no longer opens on its own. The packaged app never shows it. |

Restart the app after changing `.env`.

The e2e tests keep the onboarding from opening on its own: `launch()` starts the app without `BUGDETECTIVE_E2E_SHOW_ONBOARDING`, and the onboarding tests pass `BUGDETECTIVE_E2E_SHOW_ONBOARDING=true` to see it as a new player does. The variable is read only in e2e mode (`BUGDETECTIVE_E2E=1`).

## Running directly in WSL 2 (Linux)

The app also runs as a Linux app inside WSL 2, shown on the Windows desktop through WSLg. Requirements:

- Windows 11 (or Windows 10 with WSLg) and Node.js 26.12.1 in the distro (`nvm use`), with pnpm 12.15.0 (`npm install -g pnpm@12.15.0`).
- Docker Desktop with **WSL integration enabled for this distro** (Settings → Resources → WSL integration), so `docker` works inside WSL. With the integration off, the checklist reports Docker as not installed (the `docker` CLI is not there), even though Docker Desktop runs on Windows. Docker Engine installed in the distro also works.
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
| `pnpm test` | WSL or Windows | Vitest unit tests (no game project needed): the `notes` example project and its QA CLI, how the e2e tests find SupportDesk, Kanban rules, state validation, QA result parsing and messages, checksums, the projects catalog (source, cache, fallback, `catalog.local.json`), the local manifest, content sources (local git repos and a mock GitHub server), backup manifests, Windows detection, the game controller, the code review (review configuration and path matching, comparison parsing, review data, the checkout and return state machine with crash recovery) |
| `pnpm run test:stories` | WSL or Windows | Every Storybook story as a test in Chromium (vitest browser mode): it must render and pass axe (WCAG AA, contrast included); interactive stories play their flow. The stories use a fake `window.bugDetective` and data captured from the app playing the notes fixture (`src/renderer/src/storybook/`, regenerated with `BUGDETECTIVE_UPDATE_STORY_DATA=1` and `test/e2e/story-fixtures.spec.ts`). Part of the pre-push hook. Run `npx playwright install chromium` once. |
| `pnpm run test:coverage` | WSL or Windows | Coverage (v8) of the unit tests and the stories; HTML report in `coverage/`. The Docker layer (runtime, workspace, QA) is covered by the integration tests, `index.ts` and the preload by the e2e tests. |
| `pnpm run storybook` | WSL or Windows | Storybook on port 6006, with the theme and language in its toolbar (`pnpm run build-storybook` builds it into `storybook-static/`). Every new visual component gets a story. |
| `pnpm run test:integration` | Windows or Linux/WSL 2 + Docker | Real Docker and git on the `notes` example project (`test/fixtures/notes`: a Node app without dependencies, three tickets and a minimal QA CLI, laid out like a published project by `test/helpers/notes-project.ts`; its QA image has no Chromium): unlock ticket 1, QA on the buggy stage (Gate 2 fails), infinite-loop timeout, `reference.patch` applied in the workspace container (both gates pass), next stage, export/delete/restore, interrupted QA (`qa-flow`, `bugdetective-test-*` resources); the code review: approved snapshot from an uncommitted fix, review branch and its recreation, checkout and return with uncommitted/untracked/excluded files, edits on the review branch, crash recovery, a Done review, the return before QA, export/restore and a new game (`review-flow`, `bugdetective-review-test-*` resources); the Docker cleanup, leftovers and everything (`docker-cleanup`, `bugdetective-cleanup-test-*` resources and image tags of its own); the dev server: Start and Stop server, a server started from the terminal, no process left behind (`dev-server`, `bugdetective-devserver-test-*` resources). Never touches the player's resources. Run `pnpm run build` first. |
| `pnpm run test:e2e` | Windows or Linux/WSL 2 (WSLg) | Playwright for Electron with the fake runtime, playing SupportDesk from `../supportdesk-qa` or the pinned publication (`test/e2e/global-setup.ts`; `BUGDETECTIVE_E2E_PINNED_SUPPORTDESK=1` forces the pinned one), and reading the keys, counts and texts it checks from the version in use (`test/e2e/content.ts`); a newer publication is picked up by changing `SUPPORTDESK_QA_REF` (its scenario comes from `launch()`; `simulate()` in `test/e2e/fixtures.ts` changes it while the app runs, e.g. Docker stopping or a dev server started in the terminal): first-run checklist, Rafaela's onboarding (mandatory the first time, starts over after a restart, the "?" replay, the development skip), window size (every screen fits 1280 × 640 and scrolls below it), the Dashboard (work desk states, drawer, Local environment and the dev server row), Docker banner, Kanban drag rules, ticket panel, code review (layout, file list, split diff, whitespace toggle, identical solutions, review banner, button states), language, restart, Settings tabs (versions, disk usage, QA limit, last export, locked actions) |
| `pnpm run test:e2e:headless:linux` | Linux/WSL 2 | The same e2e tests inside a virtual display (`xvfb-run`; install it with `sudo apt install xvfb`): no window opens on the desktop and the tests never take the mouse or the keyboard. Extra Playwright arguments go at the end, e.g. `pnpm run test:e2e:headless:linux test/e2e/kanban.spec.ts`. |
| `pnpm run test:real-runtime` | Windows or Linux/WSL 2, + Docker + VS Code | `test/real-runtime`: the full game loop through the real UI (all four tickets, VS Code attach, restart during QA, export/restore) and, with `BUGDETECTIVE_INSTALLED_EXE`, ticket 1 on the installed app. Opens VS Code windows. Runs locally as the pull request gate (`tools/open-pr.sh`, see "Continuous integration"). |

### Continuous integration

`.github/workflows/ci.yml` runs on GitHub Actions:

| Job | When | What |
| --- | --- | --- |
| `fast` | every pull request into `main`, every push to `main` | `check:action-pins`, typecheck, lint, unit tests and stories (Chromium) with the coverage floor (`test:ci:fast`); its blob report is the `coverage-fast` artifact |
| `heavy` | pull requests into `main` (and by hand) | integration tests on the runner's Docker (`test:ci:integration`, blob report `coverage-integration`), then the e2e tests on Electron under Xvfb; `test-results/` and `playwright-report/` are uploaded as the `heavy-test-results` artifact |
| `coverage` | after `fast` and `heavy` | merges the two blob reports and enforces the full coverage floor (`test:ci:coverage`); nothing runs again |

No test runs twice in the CI: the `test:ci:*` scripts of `package.json` exist for that (each layer records a blob report with its coverage, `.vitest-reports/`, git-ignored). Locally `pnpm run test:coverage:full` still runs everything in one go.

What needs the real runtime (Docker Desktop, VS Code, the Windows toolchain) does not run on GitHub's hosted runners. Pull requests are opened with `tools/open-pr.sh`, which pushes the branch and opens (or updates, with a comment) the pull request. The script first syncs the Windows copy and runs there (through `tools/win.sh`) `pnpm run test:real-runtime` (the whole game loop, about 5 minutes) and, when the branch changes the renderer, the preload, the platform layer, the e2e tests or the build configuration, `pnpm run test:e2e` on Windows too (about 8 more minutes); nothing is pushed unless they pass, and the result is written into the pull request. `--skip-real-runtime` is for a pull request the suite cannot speak to: the body must give the reason in a line starting with `Real-runtime skipped:`, and it is never used for a version tagged for players. A red run stops before anything is pushed; the logs stay in `pr-gate/` (git-ignored).

```sh
desktop/tools/open-pr.sh --title "feat(scope): subject" --body-file /path/to/body.md [--skip-real-runtime]
```

It needs Docker Desktop running and VS Code installed on Windows (see "Windows development from WSL 2"). To include the installed-app spec, build the test build (`tools/win.sh pnpm run dist:win:test`) and pass its executable: `BD_WIN_ENV='BUGDETECTIVE_INSTALLED_EXE=C:\Users\<you>\bugdetective-dev\desktop\dist\win-unpacked\Bug Detective.exe'`. That folder is the installer's payload, so nothing gets installed; a copy installed from the test build lives in `%LOCALAPPDATA%\Programs\Bug Detective`. `BD_WIN_ENV` takes one `NAME=value` per line.

Every action in the workflows is pinned by commit hash (`uses: owner/repo@<40 hex> # vX.Y.Z`); `pnpm run check:action-pins` (`tools/check-action-pins.mjs`) fails otherwise, and Dependabot (`.github/dependabot.yml`) opens a pull request when an action has a new version. To pin a new action: `git ls-remote --tags https://github.com/<owner>/<repo> 'refs/tags/<tag>^{}'`.

### Coverage

Measured on 2026-11-02 with `pnpm run test:coverage` (unit tests and stories, 412 + 90 tests); run it
again for the current numbers (HTML report in `coverage/index.html`).

| Area | Lines | Branches |
| --- | --- | --- |
| **Total** | **67.7%** | **63.9%** |
| `src/shared` (game rules, types) | 97.0% | 92.1% |
| `src/main/platform` | 81.0% | 81.0% |
| `src/main/services` | 72.7% | 68.4% |
| `src/main` (game, IPC, runtime, entry point) | 65.9% | 59.8% |
| `src/renderer` (components and screens) | 62.9% | 59.4% |
| `src/preload` | 0% | 0% |

What this number leaves out is covered by the other suites: the Docker layer by the integration
tests (with them, `runtime.ts` 80%, `services/workspace.ts` 85%, `services/qa.ts` 92%,
`services/docker.ts` 95% of lines), and the main process's entry point (`index.ts`), the IPC
handlers, the preload and `App.tsx` by the e2e tests, which run the built app in Electron and are
not measured; those files are excluded from the measurement (`vitest.config.ts`).

Two floors are enforced (the run fails below them), each set at the measured value minus two
points; raise them when coverage rises:

| Command | Runs | Floor (lines / branches / functions) | Where |
| --- | --- | --- | --- |
| `pnpm run test:coverage` | unit tests and stories | 70% / 65% / 59% (`coverage.thresholds` in `vitest.config.ts`) | CI job `fast`, local |
| `pnpm run test:coverage:full` | unit tests, stories and integration tests (Docker) | 78% / 71% / 69% (`test:ci:coverage` passes them on the command line; measured 80.9% / 73.0% / 71.2% on 2026-11-03) | CI job `coverage` (merged reports of `fast` and `heavy`), local |

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
| `pre-push` | `pnpm run verify:push`: typecheck and unit tests (under a minute) | anything fails |

The stories, the integration tests and the e2e tests run in CI (see "Continuous integration" above), not in the hook.

The hooks need Node.js 26 on the `PATH` of the shell that runs git. If you commit from an editor whose git does not load nvm, create `~/.config/husky/init.sh` with `export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"`. To skip the hooks once (not recommended): `git commit --no-verify` / `git push --no-verify`. The VS Code ESLint extension must use the toolchain in `tools/lint`: set `"eslint.nodePath": "tools/lint/node_modules"` in the workspace settings (`"desktop/tools/lint/node_modules"` when the workspace is the parent folder).

## Installer

```powershell
pnpm run dist:win    # dist\Bug-Detective-Setup-<version>.exe (not signed)
```

**Fuses.** The packaged app has the Electron security fuses flipped (`tools/after-pack.mjs`): it cannot run as plain Node, ignores `NODE_OPTIONS` and the inspector flags, and loads code only from its archive. It also ignores `BUGDETECTIVE_USER_DATA`. `pnpm run dist:win:test` and `pnpm run dist:linux:test` build the test build, which keeps the fuses as they are and reads that variable: `installed-ticket1.spec.ts` needs it, and it is never for players.

The installer is per-user (no admin rights), lets the player choose the folder, and adds Start menu and desktop shortcuts. Uninstalling removes everything the app created in Docker (`resources/remove-docker-data.ps1`, run from `resources/installer.nsh`; nothing is done while Docker is not running) and the app data folder (`deleteAppDataOnUninstall`). An update keeps both: electron-builder runs the old uninstaller with `isUpdated`, and the cleanup step is skipped then. The script can also be run by hand: `powershell -ExecutionPolicy Bypass -File "<install folder>\resources\remove-docker-data.ps1"`. The packaged app carries `resources/docker/` (Dockerfiles, the QA CLI, `images.json`); images are built on the player's machine the first time, with the player's consent.

### Building and installing on Windows from WSL 2

When the code lives in WSL 2, the Windows installer is built with Windows Node.js on a Windows copy of the code (see [Windows development from WSL 2](#windows-development-from-wsl-2)), then installed on Windows like any other app. Every command below runs in a WSL terminal, from `desktop/`.

**Once per computer:**

1. Download the official Node.js 26.12.1 Windows zip (`node-v26.12.1-win-x64.zip`) and extract it to `%USERPROFILE%\bugdetective-dev\tools\node-v26.12.1-win-x64` (from WSL: `/mnt/c/Users/<you>/bugdetective-dev/tools/`). `tools/win.sh` uses it; another folder can be set with `BUGDETECTIVE_WIN_NODE`.
2. Install pnpm next to that `node.exe`:

   ```sh
   tools/win.sh npm install -g pnpm@12.15.0
   tools/win.sh pnpm --version    # 12.15.0
   ```

   npm warns that pnpm's install scripts did not run; pnpm works without them. If a build later says `'pnpm' is not recognized`, this step is missing.

**Every build:**

```sh
tools/sync-windows.sh                              # copies desktop/, ../supportdesk/ and ../supportdesk-qa/ to C:\Users\<you>\bugdetective-dev
tools/win.sh pnpm install --frozen-lockfile        # Windows node_modules (never shared with WSL)
tools/win.sh pnpm run electron:install             # the Windows Electron binary
tools/win.sh pnpm run dist:win                     # build + installer
```

The installer is `C:\Users\<you>\bugdetective-dev\desktop\dist\Bug-Detective-Setup-<version>.exe` (from WSL: `/mnt/c/Users/<you>/bugdetective-dev/desktop/dist/`). Sync again after every change: the Windows copy does not follow WSL by itself.

**Install or update:**

1. Close Bug Detective if it is open.
2. Run the installer. Double-click it in Explorer, or install silently from WSL into the folder of the previous install:

   ```sh
   powershell.exe -NoProfile -Command "Start-Process -FilePath 'C:\Users\<you>\bugdetective-dev\desktop\dist\Bug-Detective-Setup-<version>.exe' -ArgumentList '/S' -Wait"
   ```

3. The app lands in `%LOCALAPPDATA%\Programs\Bug Detective` (unless another folder was chosen). Installing over an existing install is an update: the game state, saves and Docker data stay. The installer is not signed, so Windows SmartScreen may warn on the first start.

The version number comes from `package.json`. A rebuild with the same version still replaces the installed files; the date of `Bug Detective.exe` in the install folder shows which build is installed. Uninstalling (Windows Settings → Apps) removes the app's Docker data and its app data folder, as described above.

## Configuration

| | |
| --- | --- |
| State | `%APPDATA%\Bug Detective\state.json` (versioned JSON, atomic writes, validated in `services/state.ts` after the migrations of `services/migrations.ts`; a file older than the baseline, schema 8, is kept aside as `state.corrupt-<time>.json` and a new game starts) |
| Ticket packages | `%APPDATA%\Bug Detective\projects\<projectId>\packages\stage-N.zip` and `stage-N\`, by queue position (outside the Docker volume) |
| Review data | `%APPDATA%\Bug Detective\projects\<projectId>\reviews\ticket-N\` (`review.json` and `snapshot.diff`, the approved snapshot as a diff from the ticket's commit) for every ticket that passed QA, kept for every project; included in exports |
| Projects screen | The **Projects** screen (shown once a project is done) switches the active project. Only one project is in Docker: its containers, volumes and QA image carry `bugdetective.project=<id>`, and the app removes other projects' resources on start, before every install and in **Clean up Docker leftovers**. A switch is recorded in the state and resumed after a crash (**Finish the switch** on the Dashboard). Saves (format 3) hold every project's packages and PRs, and each played project's source and version floor. |
| Project content | Installed app: `%APPDATA%\Bug Detective\projects\<projectId>\content\` (`qa.zip`, `code\<commit>.zip` for every ticket, `cache.json`). Filled when the app starts online with nothing downloaded and by **Download and install**; picking a ticket looks for a newer publication first and falls back to the cache offline. The first download needs the internet. |
| Review configuration | `review.json` at the root of the project's `qa` branch, optional: `{ "exclude": ["<glob>", …], "includeTests": true }`. Built-in excludes always apply on top (dependencies, lockfiles, `*.db`, `*.sqlite*`, `dist/`, `build/`, `coverage/`, `.env*`, logs). |
| Projects | The projects catalog: `projects.json` on the main branch of [`bug-detective-project/catalog`](https://github.com/bug-detective-project/catalog) (`id`, `repository`, `qaRef`, `starter`, `minAppVersion`, `hidden`). The app downloads it when it starts, when a ticket is taken and when Projects opens, keeps the last valid copy in `%APPDATA%\Bug Detective\catalog.json`, and before its first download uses the copy bundled at build time (`resources\catalog.fallback.json`, downloaded by `pnpm run prepare:resources`). A new game starts with the catalog's starter and stays in its project. A project that needs a newer app (its `minAppVersion`, or a newer content `formatVersion`) shows "Update Bug Detective"; a hidden project shows only to players who played it. |
| Content source | Each project downloads from its `repository` on its `qaRef`; the manifest must declare the project's `id`. The game keeps each played project's source and the newest version it accepted from the official catalog (`projectSources` in `state.json`): an older publication is ignored, and a project that left the catalog keeps playing from that source. Development: `desktop/catalog.local.json` (see "Getting the SupportDesk repository"); tests: `BUGDETECTIVE_CATALOG_FILE`, a catalog file whose projects may name a `qaDir`. The installed app always reads the official catalog. |
| Container limits | `BUGDETECTIVE_WORKSPACE_MEMORY` (default `3g`), `BUGDETECTIVE_WORKSPACE_PIDS` (`1024`), `BUGDETECTIVE_QA_MEMORY` (`2g`), `BUGDETECTIVE_QA_PIDS` (`512`), `BUGDETECTIVE_FORWARDER_MEMORY` (`128m`) and `BUGDETECTIVE_FORWARDER_PIDS` (`64`): the memory and pids limits of the workspace container, of the QA containers and of the forwarder, as `docker run --memory` and `--pids-limit` take them. Read when a container is created, so a change applies to the next one (in development from `desktop/.env`; for the installed app, set in the system before opening it). An invalid value keeps the default. |
| Logs | `%APPDATA%\Bug Detective\logs\bug-detective-<YYYY-MM-DD>.log`: one file per day the app started (`electron-log`, level info; `console.*` of the main process and every line of the install and QA logs), the 7 most recent kept, the user folder written as `~`. **Settings → About → Copy diagnostics** copies versions, the environment and the last 200 lines; **Open logs folder** opens the folder (under WSL, in Windows Explorer: a bare WSL has no `xdg-open`); a failure shows its reason in a toast. The main process logs one line at every start, so the day's file always exists. In the e2e tests the button opens nothing: the path goes to `<userData>/opened-paths.log` and `BUGDETECTIVE_E2E_OPEN_PATH_PROBLEM` is its answer. |
| Data folder | `BUGDETECTIVE_USER_DATA` replaces `%APPDATA%\Bug Detective` (tests, clean-profile checks). An installed app ignores it, unless it is the test build |
| Docker resources | Volumes `bugdetective-workspace` (the player's repository), `bugdetective-vscode-server`, `bugdetective-qa-cache` (dependency cache), `bugdetective-qa-input` (the copy of the workspace the last QA run tested); containers `bugdetective-workspace` and `bugdetective-forward-<project id>` (the port forwarder); internal network `bugdetective-net-<project id>`; images `bugdetective-workspace:<hash>`, `bugdetective-qa:<hash>`; QA containers `bugdetective-qa-*`. All labeled `bugdetective.role`. |

## Publishing a project (GitHub)

Each game project is one public repository in the `bug-detective-project` organization, with `main` (the app), `qa` (the QA suite and the content) and one branch per ticket. **The `qa` branch is the publication:** its `manifest.json` lists every ticket with its branch, its commit, its tag and the SHA-256 digests of its code and package. There are no GitHub Releases. The desktop app finds each project's repository in the projects catalog.

Tickets are named `<track>-<order>`, with the tracks `front` and `back` (`front-1`, `front-2`, …, `back-1`, …). The same name is the ticket's branch, its folder `tickets/<id>/` on `qa`, and its `id` in the manifest. The number of tickets comes from those folders; nothing in the app or the scripts assumes a count. The player picks the track of each ticket in **Get next assignment ▾** (front, back, or fullstack, which alternates), so tickets are played in any order; `bd build` makes each ticket's `gate1/` cover every other ticket.

Projects publish with `bd`, the CLI of [`bug-detective-project/catalog`](https://github.com/bug-detective-project/catalog) (see its README): on a work branch of `qa`, `npx bd build`, `npx bd verify` and `npx bd publish --version X.Y.Z`, then a pull request into the protected `qa`, whose `project / validate` check runs `bd validate` and `bd verify`; the merge publishes and is tagged `qa-vX.Y.Z`. Adding, hiding or reordering projects is a pull request to the catalog's `projects.json`; neither needs a new build of the app.

**Adding a new project:** the whole process, from an empty repository to the Projects screen (the `main` and `qa` requirements, the QA CLI contract, the story, the tickets, playing it locally, publishing and listing it in the catalog), is in [docs/adding-a-project.md](docs/adding-a-project.md).

The app downloads `archive/refs/heads/qa.zip` (the manifest and every ticket package) and then `archive/<commit>.zip` for the ticket being unlocked. It checks the manifest's project and counts, the package digest and the code digest before using anything. The tag keeps each published commit reachable after a ticket branch is force-pushed; a commit GitHub no longer has is reported as an incomplete publication.

## How the workspace and VS Code fit together

- **The workspace has no way out.** Its container lives only on `bugdetective-net-<project id>`, an internal Docker network: no internet, no `host.docker.internal`, no local network. The app's ports reach the computer through the forwarder `bugdetective-forward-<project id>` (the same image, `forward.mjs` relaying `15173` and `3001`), which is on the normal network too and publishes `127.0.0.1:5173` and `:3001` (or the next free ports). The Dashboard's **Workspace internet** row opens the workspace after a warning (`docker network connect bridge`, no restart): the project's code then reaches the internet, the computer and the local network, which is what `npm install` or an extension that needs the network inside the container require. The game closes it again on the next ticket, on a project switch and when it quits. VS Code does not need it: the computer downloads its server and the extensions (`remote.downloadExtensionsLocally`) and `docker exec` carries them in.
- The workspace container runs `bugdetective-workspace:<hash>` (`node:26.12.1-bookworm`, the same base as SupportDesk's dev container, user `node`) with the `bugdetective-workspace` volume at `/workspaces` and the project's repository in `/workspaces/<project id>` (`/workspaces/supportdesk`), created when the container starts; the repository's git identity is `<project name> Developer <developer@<project id>.invalid>`, from the manifest. Its ports are published on `127.0.0.1` only: the container's 15173 (a small forwarder to Vite on `localhost:5173`, which only listens on localhost) and 3001 (the API). Free host ports are chosen when 5173/3001 are taken.
- Unlocking a stage imports the stage files as a commit on the internal branch `bugdetective/stages` (tagged `stage-N`; an existing tag is reused only if it holds the same snapshot), then creates `player/ticket-N` from it. Uncommitted work from the previous ticket is stashed; earlier `player/*` branches of the same game are never changed.
- The app's git commands and scripts run with `core.hooksPath=/dev/null` and `core.fsmonitor=false`: hooks or an fsmonitor planted in the repository by the player's code never run under the app (the player's own git in VS Code keeps them). **Settings → New game** also removes them from the repository, with `core.sshCommand`, `core.pager`, `core.editor` and filter or diff drivers.
- Closing the app stops QA and the workspace container (the volume stays): a QA run in progress is recorded as interrupted, `npm run dev` and VS Code's server stop with the container, and an attached VS Code window disconnects. The next action of the game starts everything again.
- The repository records its game (`git config bugdetective.game`, the state's `createdAt`). When another game unlocks a stage (a new playthrough on the same computer, or **Settings → New game**), the old `player/*` branches are renamed to `archive/<time>/player/ticket-N` and uncommitted work is stashed. A restore marks the repository with the restored game.
- Starting a ticket (To Do → In Progress, once per ticket) forces `player/ticket-N` back to `stage-N`: uncommitted changes, untracked files and extra commits are discarded (ignored files such as `node_modules` stay) and `npm run db:reset` reseeds the database. Returning from QA keeps the player's work. This step needs Docker. A failed `db:reset` (on unlock, start or workspace rebuild) never blocks the ticket: it is logged, and the Dashboard's Local environment shows an "App data: Could not be reset" row with "Try again" until a reset succeeds.
- **Open in VS Code** runs `Code.exe <commit>\resources\app\out\cli.js --new-window --folder-uri vscode-remote://attached-container+<hex of {"containerName":"/bugdetective-workspace"}>/workspaces/<project id>` with `ELECTRON_RUN_AS_NODE=1`, which is exactly what `bin\code.cmd` does, without going through `cmd.exe`.
- When the container was recreated since the last attach (a new image, another project, a restore), a VS Code window left on the old container gives up reconnecting, and opening the same folder would only focus it. So the app records the id of the last attached container in `<userData>/docker/attached-container` and, only when that id changed, closes the windows titled with the container, as the X button does. A window it cannot close (unsaved files, or Linux and WSL 2, where the app cannot list windows yet) gets one message asking the player to close it, and the next click attaches. A window on the same container is never touched.
- QA runs in a new container per attempt, with `--network none`, the stage package bind-mounted read-only, and dependencies from the cache volume (mounted read-only for test runs; only the dependency preparation, which has the network, writes to it). The workspace (without `.git` and `node_modules`) is first copied into the `bugdetective-qa-input` volume, which QA mounts read-only; edits made while QA runs do not change what it tests. The containers are always removed.
- **Code review.** When QA passes, the files QA tested (from `bugdetective-qa-input`, minus the review excludes) become the approved snapshot: stored in the app data folder and as a commit tagged `qa-approved/ticket-N` that is on no player branch. The app also builds `review/ticket-N` with two commits on the stage commit, the reference (stage + `reference.patch`) then the approved snapshot, so the snapshot commit's diff is exactly "reference → your solution". Excluded paths keep the reference's version in both commits, and both carry a `.vscode/settings.json` with `"files.readonlyInclude": { "**": true }` (merged into the project's own settings). Commits use the approval date, so rebuilding from the stored data gives the same commits. The in-app comparison uses diffs computed by git at that moment (with and without whitespace), so it works with Docker stopped.
- **Open Review in VS Code** commits the player's uncommitted and untracked work on their branch as `Bug Detective: work in progress saved automatically` (excluded paths never included; no stash), records where to return in `state.json`, checks out `review/ticket-N` with a temporary `core.excludesFile` that hides excluded files from Source Control, and opens VS Code without `--new-window` (an open window on the workspace is reused). The Source Control Graph's top commit is the approved solution; opening it shows the multi-file diff. The return (the banner's "Back to my code", and automatically before QA, Open in VS Code, accepting the review, the next assignment, starting a ticket, a new game, export, restore, and on start after a crash) saves edits made on the review branch to `review-edits/ticket-N-<time>`, restores `core.excludesFile`, checks out the player's branch, undoes the temporary commit with a mixed reset and restores the index. Every step is written to the state first, so an interrupted switch is finished on the next start.

## VS Code and your credentials

When VS Code attaches to a container, the Dev Containers extension normally carries your computer's git credentials into it (a `credential.helper` written in `/etc/gitconfig` and `~/.gitconfig` that asks VS Code, and so your Windows Credential Manager, for them), copies your `~/.gitconfig` (name and e-mail), and forwards your SSH agent and your GPG agent (from WSL too) when they run. The project's code runs in that container, so the app turns this off for its workspace container, and nothing else:

- Before every **Open in VS Code**, the app writes `dev.containers.gitCredentialHelperConfigLocation: none`, `dev.containers.copyGitConfig: false` (with the deprecated `remote.containers.copyGitConfig: false`, because the extension loses a `false` in the new key alone), `dev.containers.dockerCredentialHelper: false`, `dev.containers.githubCLILoginWithToken: false` and `remote.downloadExtensionsLocally: true` into the container's machine settings (`/home/node/.vscode-server/data/Machine/settings.json`, in the app's `bugdetective-vscode-server` volume: that is the file the extension reads when it sets the container up), and the extension's configuration file for this container only (`%APPDATA%\Code\User\globalStorage\ms-vscode-remote.remote-containers\nameConfigs\bugdetective-workspace.json`, with `remoteEnv: { "SSH_AUTH_SOCK": null }`, `remoteUser: "node"` and the workspace folder). Your global VS Code settings are never touched.
- The workspace image sets `GIT_CONFIG_GLOBAL` to a read-only file of the image and `GIT_CONFIG_NOSYSTEM=1`, so git in the container never reads a helper the extension might still write, nor a copied `~/.gitconfig`; and it ships without GnuPG, so no GPG agent is forwarded.
- What the app cannot turn off: the extension's own channel to VS Code (a socket in `/tmp`) answers credential requests from any program started from VS Code's terminal or tasks, and an SSH agent socket is still created when an agent runs. The first-run checklist warns when an SSH agent is running or a git credential for github.com is stored in the Windows Credential Manager, and the warning says what to do (stop the agent, keep no stored GitHub credential while you play). `test/real-runtime/credentials.spec.ts` checks all of this against the real VS Code.

## Security

- `contextIsolation`, `sandbox` and no `nodeIntegration` in the renderer; the preload exposes one typed object; every IPC call is validated with zod and only accepted from the app's own page.
- A strict CSP (`default-src 'none'`, scripts, styles and fonts from `'self'` only); no remote content, navigation and new windows blocked, permission requests denied.
- External commands run with `spawn` and argument arrays only. The few shell scripts run inside containers are constants; data reaches them only as positional arguments.
- `shell.openExternal` only for the help pages in `EXTERNAL_LINKS` and the workspace app on `http://127.0.0.1:<published port>/`.
- **Saves are checked against the publication.** A `.bdsave` is signed with the installation's key (`<userData>/install-key`, 32 random bytes created on first use; the manifest carries an HMAC-SHA256): a save made by another installation is restored only after a warning that it brings code that will run in the workspace. Before anything is restored, every ticket package in the save is compared with the published manifest of the version the ticket was unlocked from (the content cache, or the `qa-v<version>` tag downloaded for that) and refused when it differs (`saveTampered`), and the stage of every ticket is imported again from the verified ticket code, so the `stage-N` tags of a forged bundle never survive a restore. Without the publication at hand and without internet, the restore asks for a connection; a publication that cannot be found leaves the save unverified (`saveUnverified`) and nothing is restored.
- The images are built in the app's own BuildKit builder (`docker buildx create --name bugdetective-builder --driver docker-container`, with `--load`); after every build its cache is pruned to 2 GB, Docker's global build cache is never touched, and **Settings → Remove everything** and the uninstaller remove the builder.
- The workspace sits on an internal Docker network, closed unless the player opens it; only the forwarder is on both networks, and it publishes on `127.0.0.1` only.
- VS Code attaches without the player's git credentials, `.gitconfig` or agents (see "VS Code and your credentials" above).
- Every container runs with `--cap-drop ALL --security-opt no-new-privileges`, a memory limit and a pids limit (`services/limits.ts`: 3 GB and 1024 for the workspace, 2 GB and 512 for QA and its helpers, which run as `node`; the limits can be changed with the `BUGDETECTIVE_*_MEMORY` and `BUGDETECTIVE_*_PIDS` variables, see Configuration). A QA run killed by the memory limit is a failed attempt with its own comment.

## License

[PolyForm Noncommercial 1.0.0](LICENSE): free for noncommercial use; redistributions must keep the license and its `Required Notice:` line (the credit). Commercial use needs a separate license from the author.

The installer places the licenses of third-party material next to the app, in `resources/THIRD_PARTY_NOTICES.md`. `pnpm run build` writes it to `out/THIRD_PARTY_NOTICES.md` (`tools/write-notices.ts`): the hand-written [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), for files copied into this repository (the flag-icons SVGs; add an entry whenever you vendor one), followed by the license of every npm package Vite bundles into main, preload and renderer (React, lucide-react, react-markdown, the fonts, …), collected by the `bundledLicenses` plugin (`tools/notices.ts`). Production dependencies (`zod`, `fflate`, `tar-stream`) stay in `node_modules` with their own license files, and the development-only React DevTools chunk is left out.
