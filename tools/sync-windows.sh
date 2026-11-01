#!/usr/bin/env bash
# Syncs desktop/, supportdesk/ and supportdesk-qa/ from WSL to a Windows folder, where Windows Node runs Electron,
# the e2e tests and the installer build. node_modules is never shared between Linux and Windows.
#
#   desktop/tools/sync-windows.sh            (default target: /mnt/c/Users/<you>/bugdetective-dev)
#   BUGDETECTIVE_WIN_DEV=/mnt/c/dev/bd desktop/tools/sync-windows.sh
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

# The whole repository, including .git (LocalContentSource reads the ticket branches), and its qa
# worktree. A worktree links to its repository by absolute path, so both links are rewritten to
# the Windows copy.
rsync -a --delete \
  --exclude node_modules --exclude 'server/data/*.db*' \
  "$root/supportdesk/" "$target/supportdesk/"
rsync -a --delete \
  --exclude node_modules --exclude '.package-*' \
  "$root/supportdesk-qa/" "$target/supportdesk-qa/"
win() { wslpath -m "$1"; }
worktree_meta="$target/supportdesk/.git/worktrees/supportdesk-qa"
printf 'gitdir: %s\n' "$(win "$worktree_meta")" > "$target/supportdesk-qa/.git"
printf '%s\n' "$(win "$target/supportdesk-qa/.git")" > "$worktree_meta/gitdir"

echo "Synced to $target"
