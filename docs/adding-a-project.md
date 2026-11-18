# Adding a game project

This guide takes a new game project from an empty repository to a project players can pick on the
**Projects** screen. SupportDesk is the reference project:
[`bug-detective-project/supportdesk`](https://github.com/bug-detective-project/supportdesk), with
its `qa` branch checked out next to the desktop as `supportdesk-qa/`.

**No desktop build is needed.** The app downloads the projects catalog and every project's
content at run time, so a new project reaches players through two pull requests: one into the
project's `qa` branch (the publication) and one into the catalog's `projects.json` (the listing).
A project of someone outside the organization starts in the author's own repository: see
[Third-party projects](#third-party-projects).

## How a project fits into the app

| Piece | Where | What the desktop does with it |
| --- | --- | --- |
| The catalog | `projects.json` on the `main` branch of [`bug-detective-project/catalog`](https://github.com/bug-detective-project/catalog) | Lists the projects: `id`, `repository`, optional `qaRef`, `starter`, `minAppVersion` and `hidden`. Downloaded on start, when a ticket is taken and when Projects opens |
| `main` | The project's repository | The app, with every bug fixed. Never read by the desktop: ticket branches are built from it |
| `qa` | The project's repository, no history in common with `main` | **The publication.** The desktop downloads it whole: the manifest, the QA CLI (it builds the QA image with it), the story, the review configuration and every ticket package |
| Ticket branches | `front-1`, `front-2`, …, `back-1`, … | One single-commit branch per ticket: `main` with that ticket's bug. The desktop downloads the commit the manifest names, by digest |
| Tags | `<id>-v<version>` per ticket, `qa-v<version>` per publication | Keep every published commit reachable after a ticket branch moves |

The player's code runs in the workspace container (Node 26, the project's repository at
`/workspaces/<id>` in the workspaces volume, with the git identity `<name> Developer`), and QA runs
the project's QA CLI in its own container. The desktop never
assumes a project name or a ticket count: everything comes from the catalog, the manifest and the
`tickets/` folders.

## Before you start

- Node.js 26.12.1, git, Docker Desktop (or Docker Engine on Linux), the GitHub CLI (`gh`) logged in
  to the `bug-detective-project` organization.
- The desktop checked out and running from source (see the [README](../README.md)).
- **Agree on the project's name and id before creating anything.** The id is lowercase, starts with
  a letter and uses only letters, digits and dashes (`inventory`, `task-board`); it is the
  repository's name, the catalog's `id` and `bugDetective.project.id`.

## Rules every project follows

Published content runs on the player's PC: in the workspace container, in VS Code and in the
browser. These rules keep that safe; `bd validate` checks the ones marked with it, and the review of
a third-party project reads the rest.

- **Offline.** No bug needs a new package, and the app calls no external API: the workspace has
  no internet unless the player opens it, and a bug that cannot be fixed offline cannot be fixed at all.
- **Dependencies** (`bd validate`): every package of `main` and of every ticket branch comes from
  `https://registry.npmjs.org/` with an integrity hash (no git or URL dependencies); install
  scripts are allowed only for the packages of the catalog's `ALLOWED_INSTALL_SCRIPTS`
  (`better-sqlite3` today; a change is a pull request to the catalog); every version has been on the
  registry for at least 7 days; `.npmrc` on `main` and on every ticket branch sets `allow-git=none`,
  `allow-remote=none` and `min-release-age=7`, so the author's own `npm install` follows the same
  rules. `bd validate --offline` skips the release ages when there is no network. A package bundled
  inside a registry package (Tailwind 4's `@tailwindcss/oxide-wasm32-wasi` carries six) is accepted
  since catalog 1.5.1, but npm refuses to write the lockfile for it under `allow-remote=none`:
  create or update the lockfile with `npm install --allow-remote=all`; `npm ci` needs nothing.
- **The QA CLI installs the same way.** `--deps-only` runs `npm ci --ignore-scripts` and then
  `npm rebuild <the packages of allowScripts>`, and refuses a lockfile with a `resolved` outside the
  registry: a dependency never runs a script on the player's machine that the rules do not allow.
- **`.vscode/`** (`bd validate`): only `settings.json`, `extensions.json` and `launch.json`, on
  `main` and on every ticket branch, and `extensions.json` recommends only the catalog's allowed
  extensions (`ALLOWED_VSCODE_EXTENSIONS` in `src/contract/policy.ts`: ESLint, Prettier and the
  like). No `tasks.json`: a task can run anything when a folder opens.
- **Texts** (`bd validate`): tickets, solutions, reviews, hints and the story may ask the player to
  run commands only in the VS Code terminal of the workspace, and only against `localhost`. Nothing
  to run on the PC: no downloads piped into a shell, package installs, `rm -rf`, PowerShell or
  registry changes. `bd validate` names the file and the line.
- **The API checks `Host`.** Every project API answers only `localhost` and `127.0.0.1` and gives
  403 to anything else, so a page on the internet cannot talk to the player's app.
- **No workflows in the tickets.** `main` calls the catalog's `app.yml`; `bd build` removes
  `.github/` before each ticket commit, and the only workflow of `qa` is `publication.yml`, pinned by
  hash to the catalog version the project depends on (`bd validate`).
- **Windows-safe paths** (`bd validate`): no `:`, no reserved names (`CON`, `PRN`, `AUX`, `NUL`,
  `COM1`…), no trailing dots or spaces, and no two paths that differ only by case.

## 1. Create the repository and the app (`main`)

```sh
gh repo create bug-detective-project/<id> --public
git clone git@github.com:bug-detective-project/<id>.git ../<id>   # next to desktop/
```

`main` is the finished app, with every bug of the game fixed. The workspace and QA expect a Node
project:

| Requirement | Why |
| --- | --- |
| `package.json` and `package-lock.json` at the root | The workspace installs dependencies with `npm ci`, cached by the lockfile |
| `npm run dev` serves the client on **5173** (on `localhost`) and the API on **3001** | **Start server** and **Open app in browser** reach those ports through the workspace's forwarder; **Stop server** stops `npm run dev` and `node --watch` processes |
| `npm run db:reset` | The desktop resets the project's data before every ticket |
| A test suite (`npm test`) | `bd build` turns the project's tests into each ticket's `gate1/` |
| ESLint and Prettier (TypeScript or JavaScript projects) | Set up like SupportDesk: ESLint formats TS/JS, Prettier the rest, format on save in `.vscode/settings.json`, `lint` and `format` scripts, on `main` and every ticket branch |
| `.npmrc` with the dependency rules | `allow-git=none`, `allow-remote=none` and `min-release-age=7`; `bd validate` requires it on `main` and on every ticket branch (see [the rules](#rules-every-project-follows)) |
| The API checks the `Host` header | Answers only `localhost` and `127.0.0.1` (403 to anything else), so a page on the internet cannot reach the player's app through the browser |
| `.github/workflows/ci.yml` calling the catalog's `app.yml` | The CI of `main`: `npm ci`, `lint`, `format:check` and `test` on every push and pull request. `bd build` keeps `.github/` out of the ticket branches, so players never get workflows |

```yaml
# .github/workflows/ci.yml on main
name: ci
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
jobs:
  app:
    uses: bug-detective-project/catalog/.github/workflows/app.yml@8547e2d39458d5aa575696d376b3637fb5a1f9a5 # v1.6.0
```

A project with [services](#services-a-database-for-the-project) also passes the two inputs below, so
`npm test` runs with its services up. `services.json` is a file on `main` with the same `services`
object the `qa` declares (the workflow sees only `main`):

```yaml
    with:
      services-file: services.json
      catalog-ref: 8547e2d39458d5aa575696d376b3637fb5a1f9a5
```

The job runs `bd with-services --file services.json -- npm test`: `bd` starts each service in Docker
on a free port, sets the declared variables for the command and removes the containers afterwards.
The same command runs the tests on your machine.

Protect `main` like `qa`: changes only through a pull request with the `app` check green.

## 2. Create the `qa` branch and its worktree

`qa` has no history in common with `main`. Create it as an orphan branch and check it out next to the
desktop:

```sh
cd ../<id>
git worktree add --detach ../<id>-qa main
cd ../<id>-qa
git checkout --orphan qa
git rm -r -q -f .
```

At its root, `qa` holds:

```text
package.json           bugDetective.project, the QA CLI's dependencies and @bug-detective/catalog
package-lock.json
run.ts                 the QA CLI (the image's entry point)
story.en.json          the client, the project and the manager's messages, in English
story.pt.json          the same in Portuguese
review.json            optional: what the code review leaves out
.github/workflows/publication.yml
tickets/<id>/          one folder per ticket (step 4)
manifest.json          written by bd publish (step 7)
```

### `package.json`

```json
{
  "name": "<id>-qa",
  "private": true,
  "type": "module",
  "bugDetective": {
    "project": {
      "id": "<id>",
      "name": "Inventory Tracker",
      "difficulty": "intermediate",
      "stack": { "frontend": "Vue · Vite", "backend": "Python · FastAPI", "database": "PostgreSQL" }
    }
  },
  "devDependencies": {
    "@bug-detective/catalog": "github:bug-detective-project/catalog#v1.5.0"
  }
}
```

`difficulty` (`beginner`, `intermediate` or `advanced`) and `stack` (any of `frontend`, `backend` and
`database`, up to 60 characters each) are optional; the Projects card leaves out what is missing.
`bd` copies them into `manifest.json`.

#### Services (a database for the project)

A project whose code needs a database declares it in the same `bugDetective.project`:

```json
"services": {
  "db": {
    "image": "postgres:17",
    "memory": "256m",
    "env": { "POSTGRES_PASSWORD": "shop", "POSTGRES_DB": "shop" },
    "variables": { "DATABASE_URL": "postgres://postgres:shop@{{host}}:{{port}}/shop" }
  }
}
```

- `image` comes from the catalog's list of allowed images (today only `postgres:17`); a new image
  enters by pull request to the catalog. The rules and the limits (up to 4 services, 64 MB to 1 GB
  each, a memory peak of 8 GB) are in the catalog's README, "Project services".
- The app starts each service in its own container next to the workspace, on the project's
  internal network (no internet, no published port), and sets the `variables` on the workspace
  with the service name as `{{host}}`: the dev server, the terminals and VS Code all see
  `DATABASE_URL=postgres://postgres:shop@db:5432/shop`. `bd verify` fills them with `127.0.0.1` and
  a free port.
- **The code never uses a fixed address.** The app, the QA CLI and `npm run db:reset` read the
  variables. `db:reset` must reset every service the project declares, not only its main database.
- The data of a service lives in a volume of its own and survives closing the app; it goes away
  with the project (a project switch, "Remove everything from Docker").
- Every QA run gets its own copy of each service, empty, on a network of that run alone, with
  the same variables; it never sees the player's data. The QA CLI must therefore prepare the data
  it needs (run the project's `db:reset`) before it tests.
- When `db:reset` fails, "Try again" on the Dashboard recreates the services first; "Recreate
  services" does the same for a service that does not start or ran out of memory.
- **Looking at the data.** Three ways, all optional for the player:
  - the workspace's terminal has the database's own client: `psql "$DATABASE_URL"`;
  - `"publish": true` on a service also publishes its port on the player's computer, on
    `127.0.0.1` only and on a free port (the service's own when it is free); the Dashboard shows
    it next to the service (`localhost:5432`), for the player's own database tools;
  - the project may recommend SQLTools and its PostgreSQL driver in `.vscode/extensions.json`
    (`mtxr.sqltools`, `mtxr.sqltools-driver-pg`), which connect from inside the workspace to
    the service by its name.
- The tests of `main` that need a service run through `bd with-services` (see the `ci.yml` of
  step 1), against a database of their own, never the one the dev server uses.
- A project with services needs `minAppVersion` 1.2.0 in the catalog.

### The QA CLI (`run.ts`)

The desktop builds the QA image from `qa` and runs `node /opt/qa/run.ts` in a container without
network. The CLI must accept:

```text
--ticket <n> --workspace <dir> --package <dir> --lang en|pt --json <file> --timeout <seconds> --deps-cache <dir>
--ticket <n> --workspace <dir> --deps-cache <dir> --deps-only --timeout <seconds>
```

- A run copies the workspace (without `node_modules`, `.git` and databases), runs the package's
  `gate1/` (the project's tests, which must pass) and then `gate2/` (the ticket's test), and writes
  the result to `--json`:
  `{ "ticket": n, "gate": 1 | 2, "status": "passed" | "failed" | "timeout", "message": "…", "tests": [{ "name", "status", "error"? }], "durationMs": n }`,
  with `message` in the `--lang` language.
- `--deps-only` (with network) runs `npm ci` in a copy of the workspace and stores `node_modules`
  in `--deps-cache` as `<key>.tar`, where the key is the SHA-256 of `package-lock.json` followed by
  `\0<node version>\0<platform>\0<arch>`. The workspace installs its dependencies from that file.
- If the CLI uses Playwright (browser tests), the image installs Chromium for it; otherwise it
  stays small.

Two references: SupportDesk's `run.ts` (Vitest and Playwright gates) and the minimal one the desktop
tests use, [`test/fixtures/notes/qa/run.ts`](../test/fixtures/notes/qa/run.ts) (`node --test`).

### The story (`story.en.json`, `story.pt.json`)

```json
{
  "client": { "name": "Northwind Supply", "about": "…", "contacts": "…", "reporters": [{ "name": "Grace Lin", "role": "Warehouse manager" }] },
  "project": {
    "name": "Inventory Tracker",
    "about": "A stock control app: products, warehouses and stock movements.",
    "stack": "Vue and Vite, Python and FastAPI, PostgreSQL",
    "skills": ["Async and state", "Tracing data flow", "Reading errors and debugging"]
  },
  "messages": {
    "welcome": { "subject": "…", "body": "…" },
    "assignments": { "front-1": { "subject": "…", "body": "…" } },
    "completion": { "subject": "…", "body": "…" },
    "trackCompletion": { "subject": "Track {{track}} done", "body": "…" }
  }
}
```

`skills` are what the project trains (1 to 12), shown under "You'll practice": the card shows the
first 5 and opens the rest with "See all", so put the main ones first. English and Portuguese need
the same count. Skills are free text: write them with the names of the skills list in the product
requirements (section 11.2), so every project speaks of a skill with the same words. Assignment messages are keyed by ticket id
and never mention another ticket (tickets are played in any order).

### `review.json` (optional)

`{ "exclude": ["server/data/**"], "includeTests": true }`: globs the code review leaves out of the
comparison, on top of the built-in ones (dependencies, lockfiles, databases, builds, logs, `.env*`).

### `publication.yml`

```yaml
name: publication
on:
  pull_request:
    branches: [qa]
  push:
    branches: [qa]
jobs:
  project:
    uses: bug-detective-project/catalog/.github/workflows/project.yml@9d4b057d50ea437c9cc15e4e1f74facf49481f44 # v1.5.0
    permissions:
      contents: write
```

Pin `project.yml` by commit hash with the version in a comment, equal to the `@bug-detective/catalog`
version of `package.json`: `bd validate` refuses a tag pin or a version that differs (the checks and
the CLI then come from the same code). A pull request into `qa` runs `bd validate` and `bd verify`
(check `project / validate`); the merge tags the publication `qa-v<version>`.

## 3. Name the tickets

Tickets are `<track>-<order>` with the tracks `front` and `back`: `front-1`, `front-2`, …, `back-1`,
… The same name is the folder `tickets/<id>/`, the ticket branch and the manifest entry. The player
picks a track for every ticket, so:

- a bug must not break any test of `main` (each ticket's `gate1/` covers every other ticket);
- a ticket's regression test is a **new test file** in its `reference.patch`, never a file of
  `main`;
- a regression test becomes part of every other ticket's `gate1/`, so it must pass on every other
  ticket's buggy branch: it may not depend on behavior another ticket breaks (`bd verify` shows it
  as a Gate 1 failure on the buggy branch);
- texts never mention another ticket.

## 4. Write each ticket (`tickets/<id>/`)

| File | Content |
| --- | --- |
| `bug.patch` | The bug, as a diff from `main` |
| `reference.patch` | The fix, plus the ticket's regression test as a new file |
| `gate2/` | The ticket's test, which fails with the bug and passes with the fix |
| `gate1/` | Generated by `bd build`: the project's tests |
| `ticket.en.md`, `ticket.pt.md` | The Jira-style ticket; its first heading is `<KEY>: <title>` |
| `hints.en.json`, `hints.pt.json` | `{ "hints": ["…", "…", "…"] }`, revealed one at a time |
| `review.en.md`, `review.pt.md` | What the senior developer says in the code review |
| `solution.en.md`, `solution.pt.md` | The explained solution |
| `ticket.json` (optional) | The kind of work, the both-sides mark and the skills the ticket trains (below) |

### `ticket.json`

```json
{
  "type": "build",
  "bothSides": false,
  "skills": { "en": ["Building components"], "pt": ["Criação de componentes"] }
}
```

| Field | Values | Without it |
| --- | --- | --- |
| `type` | `fix`, `build`, `complete`, `test`, `refactor`, `optimize`, `upgrade` or `investigate` | `fix` |
| `bothSides` | `true` when the ticket needs changes in the front end and in the back end; it still belongs to one track, the one where the symptom shows | `false` |
| `skills` | 1 to 5 skills per language, up to 60 characters each, the same count in `en` and `pt` | none |

- The card and the "Get next assignment" menu show the type and the "Front + back" mark, so the
  player knows what a ticket asks for before taking it.
- The comment of a failed Gate 2 and the introduction of the reference in Code Review follow the
  type: a `build` ticket is "not delivered yet", an `optimize` ticket has "a goal not reached".
  Word the project's own QA messages (`run.ts`) the same way.
- **The skills show only when the ticket is Done** ("You practiced"): before that they would hint
  at the cause. Never name a skill in the ticket text either.
- A ticket that is not a fix uses the same files: `bug.patch` is the diff from `main` that removes
  the feature (`build`, `complete`), slows it down (`optimize`), leaves the old dependency
  (`upgrade`) and so on; `gate2/` holds the acceptance tests or the measurement; `reference.patch`
  is the reference solution. With the patch applied, Gate 1 must still pass.
- A project with a ticket of a type other than `fix` needs `minAppVersion` 1.1.0 or newer in the
  catalog (step 8): `bd catalog-check` requires it.

## 5. Build and verify the tickets

```sh
cd ../<id>-qa
npm install
npx bd build      # regenerates every gate1/ and one single-commit branch per ticket (commit the gate1/ changes)
npx bd verify     # with the bug: gate1 passes, gate2 fails; fixed: both pass (Docker)
npx bd validate   # folders, story, review.json and the manifest against the branches
```

Never create or edit ticket branches by hand: `bd build` owns them.

## 6. Play it locally

Point the desktop at the local folder, then run it:

```jsonc
// desktop/catalog.local.json (git-ignored), or Settings → Development in the running app
{ "catalog": { "file": "../dev-projects/catalog.json" } }
```

```jsonc
// ../dev-projects/catalog.json: a file catalog may name a local qaDir instead of a repository
{ "projects": [{ "id": "supportdesk", "qaDir": "../supportdesk-qa", "starter": true }, { "id": "<id>", "qaDir": "../<id>-qa" }] }
```

```sh
cd desktop
BUGDETECTIVE_DEV_SHOW_PROJECTS=true pnpm dev   # shows Projects from the start
```

Switch to the project on the Projects screen and play every ticket: download, Start server, VS Code,
QA (fail, then pass with the fix), the code review and the next ticket.

## 7. Publish

1. Push `main` and protect `qa` with a ruleset: changes only through a pull request, with the
   status check `project / validate` required, the branch up to date before merging, and a review
   from a code owner (`CODEOWNERS` naming the organization's maintainers). Protect the tags too
   (`v*`, `qa-v*`, `*-v*`: no update, no deletion).
2. On a work branch of `qa`:

   ```sh
   git switch -c publish/1.0.0
   npx bd publish --version 1.0.0
   ```

   It validates, writes and commits `manifest.json` and pushes the ticket branches and the work
   branch. It never pushes `qa` and creates no tags: nothing permanent exists before the merge. Run
   it again after a failed push and it only redoes the pushes; `bd publish --abort --version 1.0.0`
   undoes a publication that was not pushed yet.
3. Open the pull request into `qa` (the link `bd publish` prints). When `project / validate` passes
   and a code owner approves, merge it: the merge publishes and tags it `qa-v1.0.0` and each new
   ticket commit `<id>-v1.0.0`. Housekeeping on `qa` (README, workflows, `CODEOWNERS`, `.npmrc`)
   needs no new version.

Every later change (tickets, QA CLI, story, review) is a new version through the same three steps.

## 8. List it in the catalog

Open a pull request into the catalog's `main` adding the project to `projects.json`:

```json
{ "id": "<id>", "repository": "bug-detective-project/<id>", "hidden": true }
```

- `hidden: true` keeps it off the Projects screen of players who never played it: useful for a
  first test with the installed app. Remove it to release the project.
- `minAppVersion` keeps it from apps that cannot play it yet.
- The array's order is the order of the cards: the `starter` (exactly one) first, then the projects
  from beginner to advanced. `bd catalog-check` refuses a project listed after a higher level.

The catalog's check validates the file and every listed project before the merge. Players get the
new list the next time the app refreshes the catalog (`raw.githubusercontent.com` may cache it for
about five minutes).

## 9. Check it in the installed app

Open the installed app, go to **Projects**, and play the new project's first ticket from the
published content. Then remove `hidden` from the catalog entry.

## Third-party projects

Every project lives in the `bug-detective-project` organization: the catalog accepts no other
owner, and so does the desktop. An author outside the organization follows the same guide in their
own repository, then:

1. **Develops and plays it locally.** The steps above, with `catalog.local.json` pointing at the
   local `qa` folder (step 6); `bd validate` and `bd verify` pass on the `qa` branch.
2. **Proposes it** with a "New project" issue in [`catalog`](https://github.com/bug-detective-project/catalog/issues/new/choose):
   name, repository, stack, skills, and the confirmations of the form (the rules above).
3. **Review.** A maintainer runs the catalog's `validate-remote` workflow on the repository
   (`bd validate --remote`, through GitHub's API: nothing of the project is cloned or executed) and
   reviews it against the checklist of the catalog's pull request template: `package.json` scripts
   (`pre*`/`post*`), new dependencies and their origin, network calls in the server, texts asking
   to run commands, recommended extensions, `.npmrc`, the `Host` check.
4. **The repository moves into the organization** (a transfer, or `git push --mirror` to
   `bug-detective-project/<id>`) with the standard protection (`qa` ruleset, `CODEOWNERS`, tag
   rules) and the author as a writer.
5. **It enters the catalog** with `hidden: true` for a first check in the installed app (step 8),
   and is released by removing `hidden`.

From then on the author publishes with `bd publish` and a pull request into `qa`; the merge needs
the approval of a code owner of the organization.

## Checklist

- [ ] Name and id agreed; repository created with `main` (dev on 5173 and 3001, `db:reset`, tests, ESLint and Prettier, `.npmrc`, the `Host` check, `ci.yml` calling `app.yml`).
- [ ] The rules above: offline, dependencies from the registry and at least 7 days old, `.vscode/` and texts within the allowed lists.
- [ ] `qa` worktree with `package.json` (`bugDetective.project` with `difficulty` and `stack`), `run.ts`, both stories (with their `skills`, the main ones first), `review.json`, `publication.yml`.
- [ ] Every ticket folder complete, with its `ticket.json` when the ticket is not a plain fix or names skills; `bd build`, `bd verify` and `bd validate` pass.
- [ ] Played end to end locally through `catalog.local.json`.
- [ ] `qa` protected; `bd publish` and the pull request merged (`qa-v1.0.0`).
- [ ] Catalog pull request merged (first `hidden`), checked in the installed app, then released.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| "Installing dependencies failed" when downloading the environment | The QA CLI does not support `--deps-only`, or `npm ci` fails on the lockfile |
| QA always times out | A test hangs, or the CLI does not stop at `--timeout` |
| "Start server" never turns green | `npm run dev` does not listen on 5173 on `localhost` |
| The project shows "Update Bug Detective" | Its `minAppVersion` or the manifest's `formatVersion` is newer than the app |
| `bd validate`: "must be newer" | Every publication needs a version above the one published on `qa` |
| `bd validate`: "is not allowed" (extension), "pipes a download into a shell" (text), "has been on the registry for" (dependency) | The rules above; the message names the file and the line, or the branch and the package |
| `bd validate`: "must pin project.yml by commit hash" | `publication.yml` uses a tag; pin the hash of the catalog version `package.json` depends on, with `# vX.Y.Z` |
