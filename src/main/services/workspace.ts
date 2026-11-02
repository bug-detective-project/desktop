/**
 * The player's workspace: a Git repository in the `bugdetective-workspace` Docker volume, mounted
 * at /workspaces/supportdesk in a long-running container. All Git operations run in that
 * container with `docker exec`. Shell scripts below are constants; variable data is only ever
 * passed as positional arguments ("$1", "$2"), never interpolated into the script.
 */
import { createHash } from 'node:crypto';
import { MAX_SAVE_BYTES } from './backup.ts';
import { readTar, writeTar } from '@bug-detective/catalog/contract';
import type { ArchiveFile } from '@bug-detective/catalog/contract';
import { labelArgs, mountArg } from './docker.ts';
import type { ContainerInfo, Docker } from './docker.ts';
import type { RunOptions } from './process.ts';

export const WORKSPACE_DIR = '/workspaces/supportdesk';
export const CACHE_DIR = '/opt/bugdetective-cache';
export interface ResourceNames {
  prefix: string;
  container: string;
  volume: string;
  vscodeVolume: string;
  cacheVolume: string;
  /** The copy of the workspace that QA tests; after a pass, the approved snapshot is read from it. */
  qaInputVolume: string;
}

/** Docker resource names. Tests use another prefix so they never touch a player's volume. */
export function resourceNames(prefix = 'bugdetective'): ResourceNames {
  if (!/^[a-z][a-z0-9-]{0,40}$/.test(prefix)) {
    throw new Error(`Invalid resource prefix: ${prefix}`);
  }
  return {
    prefix,
    container: `${prefix}-workspace`,
    volume: `${prefix}-workspace`,
    vscodeVolume: `${prefix}-vscode-server`,
    cacheVolume: `${prefix}-qa-cache`,
    qaInputVolume: `${prefix}-qa-input`,
  };
}
/** Container ports: the forwarder in front of Vite, and the Express API. */
export const CONTAINER_PORTS = { client: 15173, api: 3001 } as const;
const PREFERRED_HOST_PORTS = { client: 5173, api: 3001 } as const;

/** The player's branch for a ticket. Internal: never shown in the UI. */
export const playerBranch = (stage: number) => `player/ticket-${stage}`;

const SCRIPTS = {
  importStage: `set -eu
stage="$1"; message="$2"; src="/tmp/bugdetective-import-$stage"
rm -rf "$src" "$src.index"; mkdir -p "$src"
tar -x -C "$src"
cd ${WORKSPACE_DIR}
if [ ! -d .git ]; then
  git init -q
  git config core.autocrlf false
  git config core.eol lf
  git config user.name "SupportDesk Developer"
  git config user.email "developer@supportdesk.invalid"
fi
# The snapshot's tree, computed in a temporary index (the player's index is never touched).
cd "$src"
tree=$(GIT_DIR=${WORKSPACE_DIR}/.git GIT_WORK_TREE="$src" GIT_INDEX_FILE="$src.index" sh -c 'git add -A -f . && git write-tree')
cd ${WORKSPACE_DIR}
# Reuse the existing stage tag only if it holds exactly this snapshot (a retry, or the same content).
existing=$(git rev-parse -q --verify "refs/tags/stage-$stage^{tree}" || true)
if [ "$existing" != "$tree" ]; then
  export GIT_AUTHOR_NAME="Bug Detective" GIT_AUTHOR_EMAIL="stages@bugdetective.invalid"
  export GIT_COMMITTER_NAME="Bug Detective" GIT_COMMITTER_EMAIL="stages@bugdetective.invalid"
  if parent=$(git rev-parse -q --verify refs/heads/bugdetective/stages); then
    commit=$(git commit-tree "$tree" -p "$parent" -m "$message")
  else
    commit=$(git commit-tree "$tree" -m "$message")
  fi
  git update-ref refs/heads/bugdetective/stages "$commit"
  git tag -f "stage-$stage" "$commit" >/dev/null
fi
rm -rf "$src" "$src.index"
git rev-parse "refs/tags/stage-$stage^{commit}"`,

  /**
   * Makes the repository belong to this game. Player branches and uncommitted work left by another
   * game (an earlier playthrough on this computer, or a build without game ids) are archived, never
   * deleted: work goes to a stash, branches are renamed to archive/<time>/player/ticket-N (review
   * branches and approved-snapshot tags too, under archive/<time>/).
   * Prints the number of archived branches.
   */
  claimForGame: `set -eu
game="$1"; stamp="$2"
cd ${WORKSPACE_DIR}
if [ ! -d .git ]; then echo 0; exit 0; fi
if [ "$(git config --get bugdetective.game || true)" = "$game" ]; then echo 0; exit 0; fi
if git rev-parse -q --verify HEAD >/dev/null && [ -n "$(git status --porcelain)" ]; then
  git stash push -q -u -m "Bug Detective: uncommitted work from a previous game ($stamp)"
fi
count=0
for ref in $(git for-each-ref --format='%(refname:short)' refs/heads/player/); do
  git branch -m "$ref" "archive/$stamp/$ref"
  count=$((count + 1))
done
# Reviews belong to the game they came from: archived with the player branches, never shown in a new game.
for ref in $(git for-each-ref --format='%(refname:short)' refs/heads/review/ refs/heads/review-edits/); do
  git branch -m "$ref" "archive/$stamp/$ref"
done
for ref in $(git for-each-ref --format='%(refname:short)' refs/tags/qa-approved/); do
  git tag "archive/$stamp/$ref" "$ref" && git tag -d "$ref" >/dev/null
done
# Leave HEAD on the stage history, so the next checkout starts from a clean tree.
if git rev-parse -q --verify refs/heads/bugdetective/stages >/dev/null; then
  git checkout -q -f --detach bugdetective/stages
fi
git config bugdetective.game "$game"
echo "$count"`,

  /**
   * Starting a ticket (To Do → In Progress, which happens once): player/ticket-N is forced to the
   * clean stage commit. Uncommitted changes, untracked files and extra commits are discarded on
   * purpose; ignored files (node_modules) stay. Prints "<changed files> <extra commits>".
   */
  resetToStage: `set -eu
stage="$1"; branch="player/ticket-$stage"
cd ${WORKSPACE_DIR}
git rev-parse -q --verify "refs/tags/stage-$stage" >/dev/null
changes=$(git status --porcelain | wc -l)
commits=0
if git rev-parse -q --verify "refs/heads/$branch" >/dev/null; then
  commits=$(git rev-list --count "stage-$stage..$branch")
fi
git checkout -q -f -B "$branch" "stage-$stage"
git clean -q -f -d
echo "$changes $commits"`,

  /** Switches to player/ticket-N. Uncommitted work from the previous ticket is stashed, never lost. */
  checkoutPlayerBranch: `set -eu
stage="$1"; branch="player/ticket-$stage"
cd ${WORKSPACE_DIR}
current=$(git symbolic-ref -q --short HEAD || true)
if [ "$current" != "$branch" ]; then
  if git rev-parse -q --verify HEAD >/dev/null && [ -n "$(git status --porcelain)" ]; then
    git stash push -q -u -m "Bug Detective: uncommitted changes before ticket $stage"
  fi
  if git rev-parse -q --verify "refs/heads/$branch" >/dev/null; then
    git checkout -q "$branch"
  else
    git checkout -q -f -b "$branch" "stage-$stage"
  fi
fi`,

  /**
   * Development only ("Solve bug"): the files the reference patch (stdin) touches go back to the
   * stage commit, then the patch is applied to the working tree. The player's changes to those
   * files are lost; other files and the index stay as they are.
   */
  solveBug: `set -eu
stage="$1"; patch="/tmp/bugdetective-solve-$stage.patch"
cat > "$patch"
cd ${WORKSPACE_DIR}
git apply --numstat "$patch" | cut -f3- | while IFS= read -r file; do
  if git cat-file -e "refs/tags/stage-$stage:$file" 2>/dev/null; then
    git restore --source="refs/tags/stage-$stage" --worktree -- "$file"
  else
    rm -f -- "$file"
  fi
done
git apply --whitespace=nowarn "$patch"
rm -f "$patch"`,

  /** The reference of a ticket: the stage commit plus its reference patch (stdin), as a tar of the whole tree. */
  referenceTree: `set -eu
stage="$1"; idx="/tmp/bugdetective-reference-$stage.index"; patch="/tmp/bugdetective-reference-$stage.patch"
cat > "$patch"
cd ${WORKSPACE_DIR}
rm -f "$idx"
GIT_INDEX_FILE="$idx" git read-tree "refs/tags/stage-$stage^{commit}"
# An empty patch (an approved snapshot equal to the stage) leaves the stage tree as it is.
if [ -s "$patch" ]; then GIT_INDEX_FILE="$idx" git apply --cached --whitespace=nowarn "$patch"; fi
tree=$(GIT_INDEX_FILE="$idx" git write-tree)
rm -f "$idx" "$patch"
git archive --format=tar "$tree"`,

  /**
   * Builds the approved-snapshot tag and the two-commit review branch from a tar on stdin with
   * snapshot/ (the files QA tested, already filtered), reference/ and settings.json (the read-only
   * VS Code settings). Excluded paths (the remaining arguments, as pathspecs) and the settings file
   * keep the reference's version in the snapshot commit. Commits use a fixed date, so rebuilding
   * from the same data gives the same commits. Prints the approved, reference and snapshot commits.
   */
  buildReview: `set -eu
n="$1"; date="$2"; approvedMessage="$3"; referenceMessage="$4"; snapshotMessage="$5"; shift 5
tmp="/tmp/bugdetective-review-$n"
rm -rf "$tmp"; mkdir -p "$tmp/snapshot" "$tmp/reference"
tar -x -C "$tmp"
cd ${WORKSPACE_DIR}
if [ "$(git symbolic-ref -q HEAD || true)" = "refs/heads/review/ticket-$n" ]; then
  echo "The review is checked out" >&2; exit 3
fi
base=$(git rev-parse "refs/tags/stage-$n^{commit}")
export GIT_DIR=${WORKSPACE_DIR}/.git GIT_INDEX_FILE="$tmp/index"
export GIT_AUTHOR_NAME="Bug Detective" GIT_AUTHOR_EMAIL="review@bugdetective.invalid" GIT_AUTHOR_DATE="$date"
export GIT_COMMITTER_NAME="Bug Detective" GIT_COMMITTER_EMAIL="review@bugdetective.invalid" GIT_COMMITTER_DATE="$date"
cd "$tmp/snapshot"
GIT_WORK_TREE="$tmp/snapshot" git add -A -f -- .
approved=$(git commit-tree "$(git write-tree)" -p "$base" -m "$approvedMessage")
rm -f "$GIT_INDEX_FILE"
cd "$tmp/reference"
GIT_WORK_TREE="$tmp/reference" git add -A -f -- .
settings=$(git hash-object -w "$tmp/settings.json")
git update-index --add --cacheinfo "100644,$settings,.vscode/settings.json"
reference=$(git commit-tree "$(git write-tree)" -p "$base" -m "$referenceMessage")
cd "$tmp/snapshot"
GIT_WORK_TREE="$tmp/snapshot" git add -A -f -- . ':(exclude,literal).vscode/settings.json' "$@"
snapshot=$(git commit-tree "$(git write-tree)" -p "$reference" -m "$snapshotMessage")
git tag -f "qa-approved/ticket-$n" "$approved" >/dev/null
git update-ref "refs/heads/review/ticket-$n" "$snapshot"
cd /; rm -rf "$tmp"
echo "$approved $reference $snapshot"`,

  /** Where the player is before a review: "<branch or ->\n<HEAD>\n<index tree>\n<core.excludesFile or ->". */
  reviewReturnPoint: `set -eu
cd ${WORKSPACE_DIR}
branch=$(git symbolic-ref -q --short HEAD || echo -)
head=$(git rev-parse HEAD)
index=$(git write-tree)
excludes=$(git config --get core.excludesFile || echo -)
printf '%s\n%s\n%s\n%s\n' "$branch" "$head" "$index" "$excludes"`,

  /**
   * Saves uncommitted and untracked work as a temporary commit on the current branch (never a
   * stash). Excluded paths (arguments) are never added. Prints the commit, or "-" when nothing changed.
   */
  reviewSaveWork: `set -eu
message="$1"; shift
cd ${WORKSPACE_DIR}
git add -A -- . "$@"
if git diff --cached --quiet; then echo -; exit 0; fi
git -c core.hooksPath=/dev/null commit -q --no-verify -m "$message"
git rev-parse HEAD`,

  /** Checks out the review; excluded files are hidden from Source Control meanwhile (stdin: the excludes file). */
  reviewSwitch: `set -eu
n="$1"
cd ${WORKSPACE_DIR}
cat > .git/bugdetective-review-exclude
git config core.excludesFile "${WORKSPACE_DIR}/.git/bugdetective-review-exclude"
git checkout -q "review/ticket-$n"`,

  /**
   * Returns to the player's code. Safe to run again after an interruption at any point:
   * 1. changes made on the review branch are committed to review-edits/ticket-N-<stamp>;
   * 2. the previous core.excludesFile comes back; 3. the player's branch (or detached HEAD) is checked out;
   * 4. the temporary commit is undone with a mixed reset and the index is restored, only while it is the tip.
   * Prints "edits" and "restored" or "tipMoved" lines.
   */
  reviewReturn: `set -eu
n="$1"; branch="$2"; head="$3"; wip="$4"; index="$5"; excludes="$6"; stamp="$7"; editsMessage="$8"; shift 8
cd ${WORKSPACE_DIR}
current=$(git symbolic-ref -q --short HEAD || true)
case "$current" in
  "review/ticket-$n"|"review-edits/ticket-$n-"*)
    if [ -n "$(git status --porcelain -- . "$@")" ]; then
      if [ "$current" = "review/ticket-$n" ]; then git checkout -q -b "review-edits/ticket-$n-$stamp"; fi
      git add -A -- . "$@"
      git -c core.hooksPath=/dev/null commit -q --no-verify -m "$editsMessage"
      echo edits
    fi;;
esac
if [ "$excludes" = - ]; then git config --unset core.excludesFile || true; else git config core.excludesFile "$excludes"; fi
rm -f .git/bugdetective-review-exclude
tip="$head"; if [ "$wip" != - ]; then tip="$wip"; fi
if [ "$branch" = - ]; then
  # A detached HEAD: go back to it unless HEAD is already detached there (an interrupted return).
  if [ -n "$current" ]; then git checkout -q --detach "$tip"; fi
elif [ "$current" != "$branch" ]; then
  git checkout -q "$branch"
fi
if [ "$wip" != - ]; then
  now=$(git rev-parse HEAD)
  if [ "$now" = "$wip" ]; then
    git reset -q --mixed "$head"
    now="$head"
  fi
  if [ "$now" = "$head" ]; then
    git read-tree "$index"
    echo restored
  else
    echo tipMoved
  fi
fi`,

  installDepsFromCache: `set -eu
key="$1"
cd ${WORKSPACE_DIR}
rm -rf node_modules client/node_modules server/node_modules
tar -xf "${CACHE_DIR}/deps/$key.tar" -C .
printf %s "$key" > node_modules/.bugdetective-deps`,

  bundle: `set -eu
cd ${WORKSPACE_DIR}
rm -f /tmp/bugdetective.bundle
git bundle create -q /tmp/bugdetective.bundle --all >/dev/null 2>&1
cat /tmp/bugdetective.bundle
rm -f /tmp/bugdetective.bundle`,

  /** Checks a bundle in a scratch repository, before anything of the player's is touched. */
  verifyBundle: `set -eu
rm -rf /tmp/bugdetective-verify /tmp/bugdetective-verify.bundle
cat > /tmp/bugdetective-verify.bundle
git init -q /tmp/bugdetective-verify
git -C /tmp/bugdetective-verify bundle verify -q /tmp/bugdetective-verify.bundle >/dev/null
rm -rf /tmp/bugdetective-verify /tmp/bugdetective-verify.bundle`,

  restoreBundle: `set -eu
branch="$1"
cat > /tmp/bugdetective-restore.bundle
cd ${WORKSPACE_DIR}
git init -q
git config core.autocrlf false
git config core.eol lf
git config user.name "SupportDesk Developer"
git config user.email "developer@supportdesk.invalid"
git fetch -q /tmp/bugdetective-restore.bundle "refs/*:refs/*"
git checkout -q -f "$branch"
rm -f /tmp/bugdetective-restore.bundle`,
};

export interface ReviewCommits {
  /** The approved snapshot (tag qa-approved/ticket-N), its parent is the stage commit. */
  approved: string;
  /** First commit of review/ticket-N: the reference. */
  reference: string;
  /** Tip of review/ticket-N: the approved snapshot on top of the reference. */
  snapshot: string;
}

export interface ReviewBuild {
  ticket: number;
  /** ISO date used for every commit, so a rebuild gives the same commits. */
  date: string;
  messages: { approved: string; reference: string; snapshot: string };
  snapshot: readonly ArchiveFile[];
  reference: readonly ArchiveFile[];
  /** The read-only .vscode/settings.json of both review commits. */
  settings: string;
  /** Exclude pathspecs (review configuration). */
  excludes: readonly string[];
}

/** Where the player was before a review. */
export interface ReturnPoint {
  /** The checked-out branch, or null for a detached HEAD. */
  branch: string | null;
  head: string;
  /** The player's index, restored after the temporary commit is undone. */
  indexTree: string;
  /** core.excludesFile before the review, or null when it was not set. */
  excludesFile: string | null;
}

export interface ReturnRequest {
  ticket: number;
  point: ReturnPoint;
  wipCommit: string | null;
  /** Suffix of the branch that keeps changes made while the review was checked out. */
  stamp: string;
  editsMessage: string;
  excludes: readonly string[];
}

export interface ReturnResult {
  /** Changes made on the review branch were saved to a review-edits branch. */
  editsSaved: boolean;
  /** The temporary commit was no longer the branch tip, so it was left in place. */
  tipMoved: boolean;
}

const ticketArg = (ticket: number) => {
  if (!Number.isInteger(ticket) || ticket < 1 || ticket > 99) {
    throw new Error(`Invalid ticket: ${ticket}`);
  }
  return String(ticket);
};

export interface WorkspacePorts {
  client: number;
  api: number;
}

/** The host ports the workspace container publishes. */
export function publishedPorts(info: ContainerInfo): WorkspacePorts {
  return { client: info.ports[CONTAINER_PORTS.client], api: info.ports[CONTAINER_PORTS.api] };
}

export interface WorkspaceOptions {
  docker: Docker;
  image: string;
  isPortFree: (port: number) => Promise<boolean>;
  names?: ResourceNames;
  /** The game project whose code the workspace holds (labels its container and volumes). */
  project?: string | null;
}

export class Workspace {
  private readonly docker: Docker;
  private readonly image: string;
  private readonly isPortFree: (port: number) => Promise<boolean>;
  private readonly names: ResourceNames;
  private readonly project: string | null;
  private runtimeKey: string | null = null;

  constructor(options: WorkspaceOptions) {
    this.docker = options.docker;
    this.image = options.image;
    this.isPortFree = options.isPortFree;
    this.names = options.names ?? resourceNames();
    this.project = options.project ?? null;
  }

  get containerName(): string {
    return this.names.container;
  }

  async volumeExists(): Promise<boolean> {
    return this.docker.volumeExists(this.names.volume);
  }

  async info(): Promise<ContainerInfo | null> {
    return this.docker.inspectContainer(this.names.container);
  }

  /** Published host ports, or null when the container does not exist. */
  async ports(): Promise<WorkspacePorts | null> {
    const info = await this.info();
    return info ? publishedPorts(info) : null;
  }

  private async pickPort(preferred: number, avoid: Set<number>): Promise<number> {
    for (let port = preferred; port < preferred + 200; port += 1) {
      if (!avoid.has(port) && (await this.isPortFree(port))) {
        return port;
      }
    }
    throw new Error(`No free port found near ${preferred}`);
  }

  private async create(): Promise<void> {
    const avoid = new Set<number>();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const client = await this.pickPort(PREFERRED_HOST_PORTS.client, avoid);
      avoid.add(client);
      const api = await this.pickPort(PREFERRED_HOST_PORTS.api, avoid);
      avoid.add(api);
      const result = await this.docker.run([
        'run',
        '--detach',
        '--init',
        '--name',
        this.names.container,
        ...labelArgs('workspace', this.project),
        '--mount',
        mountArg({ type: 'volume', src: this.names.volume, dst: WORKSPACE_DIR }),
        '--mount',
        mountArg({ type: 'volume', src: this.names.vscodeVolume, dst: '/home/node/.vscode-server' }),
        '--mount',
        mountArg({ type: 'volume', src: this.names.cacheVolume, dst: CACHE_DIR, readonly: true }),
        '--publish',
        `127.0.0.1:${client}:${CONTAINER_PORTS.client}`,
        '--publish',
        `127.0.0.1:${api}:${CONTAINER_PORTS.api}`,
        this.image,
      ]);
      if (result.code === 0) {
        return;
      }
      await this.docker.removeContainer(this.names.container);
      if (!/port is already allocated|address already in use|ports are not available/i.test(result.stderr)) {
        throw new Error(`Could not start the workspace container: ${result.stderr.trim()}`);
      }
    }
    throw new Error('Could not find free ports for the workspace container');
  }

  /** Creates the volumes and starts the workspace container. The volume (the player's work) is never removed here. */
  async ensureRunning(): Promise<ContainerInfo> {
    await this.docker.createVolume(this.names.volume, 'workspace', this.project);
    // VS Code's server does not depend on the project, so it is kept across projects.
    await this.docker.createVolume(this.names.vscodeVolume, 'vscode-server');
    await this.docker.createVolume(this.names.cacheVolume, 'qa-cache', this.project);
    let info = await this.info();
    if (info && info.image !== this.image) {
      // A newer app version ships a newer image: recreate the container, keep the volumes.
      await this.docker.removeContainer(this.names.container);
      info = null;
    }
    if (info && !info.running) {
      const started = await this.docker.run(['container', 'start', this.names.container]);
      if (started.code !== 0) {
        // Usually a published port was taken by another program meanwhile.
        await this.docker.removeContainer(this.names.container);
        info = null;
      }
    }
    if (!info) {
      await this.create();
    }
    const running = await this.info();
    if (!running?.running) {
      throw new Error('The workspace container is not running');
    }
    return running;
  }

  private exec(command: readonly string[], options: Parameters<Docker['exec']>[2] = {}) {
    return this.docker.execChecked(this.names.container, command, { user: 'node', workdir: WORKSPACE_DIR, ...options });
  }

  private script(name: keyof typeof SCRIPTS, args: readonly string[] = [], options: Parameters<Docker['exec']>[2] = {}) {
    return this.exec(['sh', '-c', SCRIPTS[name], 'sh', ...args], options);
  }

  async git(args: readonly string[], options: Parameters<Docker['exec']>[2] = {}): Promise<string> {
    return (await this.exec(['git', ...args], options)).stdout.toString('utf8');
  }

  async hasRepository(): Promise<boolean> {
    const result = await this.docker.exec(this.names.container, ['test', '-d', `${WORKSPACE_DIR}/.git`], { user: 'node' });
    return result.code === 0;
  }

  /** The checked-out branch, or null for a detached HEAD. */
  async currentBranch(): Promise<string | null> {
    const result = await this.docker.exec(this.names.container, ['git', 'symbolic-ref', '-q', '--short', 'HEAD'], {
      user: 'node',
      workdir: WORKSPACE_DIR,
    });
    const branch = result.stdout.toString('utf8').trim();
    return result.code === 0 && branch ? branch : null;
  }

  /** Imports a stage snapshot as a commit (idempotent) and returns its commit id. */
  async importStage(stage: number, files: readonly ArchiveFile[], message: string): Promise<string> {
    const tar = await writeTar(files);
    const { stdout } = await this.script('importStage', [String(stage), message], { input: tar, timeoutMs: 120_000 });
    return stdout.toString('utf8').trim().split('\n').at(-1)!;
  }

  /** Claims the repository for a game (see claimForGame). Returns the number of archived branches. */
  async claimForGame(gameId: string, now = new Date()): Promise<number> {
    if (!/^[0-9TZ:.-]{10,40}$/.test(gameId)) {
      throw new Error(`Invalid game id: ${gameId}`);
    }
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const { stdout } = await this.script('claimForGame', [gameId, stamp], { timeoutMs: 60_000 });
    return Number(stdout.toString('utf8').trim().split('\n').at(-1)) || 0;
  }

  /** Marks the repository as belonging to a game, without archiving anything (used after a restore). */
  async setGameId(gameId: string): Promise<void> {
    await this.git(['config', 'bugdetective.game', gameId]);
  }

  async gameId(): Promise<string | null> {
    const result = await this.docker.exec(this.names.container, ['git', 'config', '--get', 'bugdetective.game'], {
      user: 'node',
      workdir: WORKSPACE_DIR,
    });
    return result.code === 0 ? result.stdout.toString('utf8').trim() : null;
  }

  /** Forces player/ticket-N to the clean stage commit (see resetToStage). */
  async resetToStage(stage: number): Promise<{ changes: number; commits: number }> {
    const { stdout } = await this.script('resetToStage', [String(stage)], { timeoutMs: 60_000 });
    const [changes, commits] = stdout.toString('utf8').trim().split('\n').at(-1)!.split(/\s+/).map(Number);
    return { changes: changes || 0, commits: commits || 0 };
  }

  async checkoutPlayerBranch(stage: number): Promise<void> {
    await this.script('checkoutPlayerBranch', [String(stage)], { timeoutMs: 60_000 });
  }

  async applyPatch(patch: string): Promise<void> {
    await this.exec(['git', 'apply', '--whitespace=nowarn', '-'], { input: patch, timeoutMs: 60_000 });
  }

  /** Development only: replaces the player's fix with the reference patch (see the solveBug script). */
  async solveBug(stage: number, patch: string): Promise<void> {
    await this.script('solveBug', [ticketArg(stage)], { input: patch, timeoutMs: 60_000 });
  }

  /** Files of the stage commit with the reference patch applied. */
  async referenceFiles(stage: number, patch: string): Promise<ArchiveFile[]> {
    const { stdout } = await this.script('referenceTree', [ticketArg(stage)], { input: patch, timeoutMs: 60_000 });
    return readTar(stdout);
  }

  /** Creates (or recreates) the qa-approved/ticket-N tag and the review/ticket-N branch. */
  async buildReview(build: ReviewBuild): Promise<ReviewCommits> {
    const tar = await writeTar([
      ...build.snapshot.map((file) => ({ ...file, path: `snapshot/${file.path}` })),
      ...build.reference.map((file) => ({ ...file, path: `reference/${file.path}` })),
      { path: 'settings.json', data: Buffer.from(build.settings), executable: false },
    ]);
    const { messages } = build;
    const { stdout } = await this.script(
      'buildReview',
      [ticketArg(build.ticket), build.date, messages.approved, messages.reference, messages.snapshot, ...build.excludes],
      { input: tar, timeoutMs: 120_000 },
    );
    const [approved, reference, snapshot] = stdout.toString('utf8').trim().split('\n').at(-1)!.split(' ');
    return { approved, reference, snapshot };
  }

  /** The commits review/ticket-N and qa-approved/ticket-N point at, or null when missing. */
  async reviewRefs(ticket: number): Promise<{ branch: string | null; tag: string | null }> {
    const resolve = async (ref: string) => {
      const result = await this.docker.exec(this.names.container, ['git', 'rev-parse', '-q', '--verify', `${ref}^{commit}`], {
        user: 'node',
        workdir: WORKSPACE_DIR,
      });
      return result.code === 0 ? result.stdout.toString('utf8').trim() : null;
    };
    const number = ticketArg(ticket);
    return { branch: await resolve(`refs/heads/review/ticket-${number}`), tag: await resolve(`refs/tags/qa-approved/ticket-${number}`) };
  }

  /** git diff between two commits, with rename detection. */
  async diff(from: string, to: string, options: { ignoreWhitespace?: boolean; pathspecs?: readonly string[] } = {}): Promise<string> {
    const whitespace = options.ignoreWhitespace ? ['--ignore-all-space', '--ignore-cr-at-eol', '--ignore-blank-lines'] : [];
    return this.git(['diff', '--no-color', '--no-ext-diff', '-M', ...whitespace, from, to, '--', '.', ...(options.pathspecs ?? [])], {
      timeoutMs: 60_000,
    });
  }

  async reviewReturnPoint(): Promise<ReturnPoint> {
    const { stdout } = await this.script('reviewReturnPoint', [], { timeoutMs: 60_000 });
    const [branch, head, indexTree, excludesFile] = stdout.toString('utf8').trim().split('\n');
    return { branch: branch === '-' ? null : branch, head, indexTree, excludesFile: excludesFile === '-' ? null : excludesFile };
  }

  /** Commits uncommitted and untracked work, except excluded paths. Returns the commit, or null when nothing changed. */
  async reviewSaveWork(message: string, excludes: readonly string[]): Promise<string | null> {
    const { stdout } = await this.script('reviewSaveWork', [message, ...excludes], { timeoutMs: 60_000 });
    const commit = stdout.toString('utf8').trim().split('\n').at(-1)!;
    return commit === '-' ? null : commit;
  }

  /** HEAD's commit, parent and subject: recognizes a temporary commit left by an interrupted review. */
  async headCommit(): Promise<{ commit: string; parent: string | null; subject: string }> {
    const [commit, parents, subject = ''] = (await this.git(['log', '-1', '--format=%H%n%P%n%s', 'HEAD'])).split('\n');
    return { commit, parent: parents.split(' ')[0] || null, subject };
  }

  async reviewSwitch(ticket: number, excludesFile: string): Promise<void> {
    await this.script('reviewSwitch', [ticketArg(ticket)], { input: excludesFile, timeoutMs: 60_000 });
  }

  async reviewReturn(request: ReturnRequest): Promise<ReturnResult> {
    const { point } = request;
    if (!/^[0-9TZ]{8,20}$/.test(request.stamp)) {
      throw new Error(`Invalid stamp: ${request.stamp}`);
    }
    const { stdout } = await this.script(
      'reviewReturn',
      [
        ticketArg(request.ticket),
        point.branch ?? '-',
        point.head,
        request.wipCommit ?? '-',
        point.indexTree,
        point.excludesFile ?? '-',
        request.stamp,
        request.editsMessage,
        ...request.excludes,
      ],
      { timeoutMs: 60_000 },
    );
    const lines = stdout.toString('utf8').split('\n');
    return { editsSaved: lines.includes('edits'), tipMoved: lines.includes('tipMoved') };
  }

  /** "<node version>\0<platform>\0<arch>" of the images, part of the dependency cache key. */
  private async runtime(): Promise<string> {
    this.runtimeKey ??= (
      await this.exec(['node', '-e', 'process.stdout.write(`${process.version}\\0${process.platform}\\0${process.arch}`)'])
    ).stdout.toString('utf8');
    return this.runtimeKey;
  }

  /** Same key as the QA CLI's --deps-cache: SHA-256 of the lockfile and the Node runtime. */
  async dependencyKey(): Promise<string | null> {
    const result = await this.docker.exec(this.names.container, ['cat', 'package-lock.json'], {
      user: 'node',
      workdir: WORKSPACE_DIR,
    });
    if (result.code !== 0) {
      return null;
    }
    return createHash('sha256').update(result.stdout).update(`\0${await this.runtime()}`).digest('hex');
  }

  async installedDependencyKey(): Promise<string | null> {
    const result = await this.docker.exec(this.names.container, ['cat', 'node_modules/.bugdetective-deps'], {
      user: 'node',
      workdir: WORKSPACE_DIR,
    });
    return result.code === 0 ? result.stdout.toString('utf8').trim() : null;
  }

  async cachedDependencies(key: string): Promise<boolean> {
    const result = await this.docker.exec(this.names.container, ['test', '-f', `${CACHE_DIR}/deps/${key}.tar`], { user: 'node' });
    return result.code === 0;
  }

  async installDependenciesFromCache(key: string, onLine?: RunOptions['onLine']): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(key)) {
      throw new Error('Invalid dependency key');
    }
    await this.script('installDepsFromCache', [key], { timeoutMs: 10 * 60_000, onLine });
  }

  async resetDatabase(onLine?: RunOptions['onLine']): Promise<void> {
    await this.exec(['npm', 'run', 'db:reset'], { timeoutMs: 120_000, onLine });
  }

  /** Asks through the forwarder, from inside the container, so host networking does not matter. */
  async isDevServerUp(): Promise<boolean> {
    const result = await this.docker.exec(
      this.names.container,
      ['curl', '--fail', '--silent', '--output', '/dev/null', '--max-time', '2', `http://127.0.0.1:${CONTAINER_PORTS.client}/`],
      { user: 'node', timeoutMs: 10_000 },
    );
    return result.code === 0;
  }

  /** Starts `npm run dev` in the background inside the container, logging to /tmp/supportdesk-dev.log. */
  async startDevServer(): Promise<void> {
    await this.docker.checked([
      'exec',
      '--detach',
      '--user',
      'node',
      '--workdir',
      WORKSPACE_DIR,
      this.names.container,
      'sh',
      '-c',
      'exec npm run dev > /tmp/supportdesk-dev.log 2>&1',
    ]);
    await this.waitForDevServer(true, 30_000);
  }

  /**
   * Stops `npm run dev`, whether it was started here or in the VS Code terminal: the npm and
   * concurrently wrappers, Vite and the API's `node --watch`. The bracket in each pattern keeps
   * pkill from matching the shell that runs it.
   */
  async stopDevServer(): Promise<void> {
    await this.docker.exec(
      this.names.container,
      ['sh', '-c', "pkill -f '[n]pm run dev'; pkill -f '[c]oncurrently'; pkill -f '[n]ode_modules/.bin/vite'; pkill -f '[n]ode --watch'; true"],
      { user: 'node', timeoutMs: 10_000 },
    );
    await this.waitForDevServer(false, 10_000);
  }

  /** Polls until the dev server answers (or stops answering); gives up quietly after `timeoutMs`. */
  private async waitForDevServer(up: boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await this.isDevServerUp()) === up) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }

  /** The repository as a git bundle; larger than a save may be, it fails instead of being cut short. */
  async bundle(): Promise<Buffer> {
    return (await this.script('bundle', [], { timeoutMs: 120_000, maxStdout: MAX_SAVE_BYTES })).stdout;
  }

  async verifyBundle(bundle: Uint8Array): Promise<void> {
    await this.script('verifyBundle', [], { input: bundle, timeoutMs: 120_000 });
  }

  /** Restores the repository from a bundle into a fresh volume and checks out `branch`. */
  async restoreBundle(bundle: Uint8Array, branch: string): Promise<void> {
    await this.script('restoreBundle', [branch], { input: bundle, timeoutMs: 120_000 });
  }

  /** Removes the container and the workspace volume (used only by restore, after the player confirmed). */
  async destroy(): Promise<void> {
    await this.docker.removeContainer(this.names.container);
    await this.docker.removeVolume(this.names.volume);
  }
}
