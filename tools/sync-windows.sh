#!/usr/bin/env bash
# Syncs desktop/, smokedesk/ and smokedesk-qa/ (the project the e2e and real-runtime tests play) and
# supportdesk/ and supportdesk-qa/ (installed-ticket1 still plays it) from WSL to a Windows folder,
# where Windows Node runs Electron, the e2e tests and the installer build. node_modules is never
# shared between Linux and Windows.
#
#   desktop/tools/sync-windows.sh            (default target: /mnt/c/Users/<you>/bugdetective-dev)
#   BUGDETECTIVE_WIN_DEV=/mnt/c/dev/bd desktop/tools/sync-windows.sh
#   desktop/tools/sync-windows.sh librarydesk   (also <project>/ and <project>-qa/, for tools/play-project.sh)
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
root=$(cd "$here/.." && pwd)
win_user=$(cd /mnt/c && cmd.exe /d /c "echo %USERNAME%" 2>/dev/null | tr -d '\r')
target=${BUGDETECTIVE_WIN_DEV:-/mnt/c/Users/$win_user/bugdetective-dev}
mkdir -p "$target"

rsync -a --delete \
  --exclude node_modules --exclude out --exclude dist --exclude build \
  --exclude test-results --exclude playwright-report \
  "$root/desktop/" "$target/desktop/"

win() { wslpath -m "$1"; }
# A game project: the whole repository, including .git (LocalContentSource reads the ticket
# branches), and its qa worktree. A worktree links to its repository by absolute path, so both
# links are rewritten to the Windows copy.
sync_project() {
  local name=$1
  rsync -a --delete \
    --exclude node_modules --exclude 'server/data/*.db*' \
    "$root/$name/" "$target/$name/"
  rsync -a --delete \
    --exclude node_modules --exclude '.package-*' \
    "$root/$name-qa/" "$target/$name-qa/"
  local worktree_meta="$target/$name/.git/worktrees/$name-qa"
  printf 'gitdir: %s\n' "$(win "$worktree_meta")" > "$target/$name-qa/.git"
  printf '%s\n' "$(win "$target/$name-qa/.git")" > "$worktree_meta/gitdir"
}
sync_project smokedesk
sync_project supportdesk
for extra in "$@"; do
  sync_project "$extra"
done

echo "Synced to $target"
