#!/usr/bin/env bash
# Plays a whole game project in the real app on Windows (Docker Desktop, the Windows toolchain):
# every ticket of both tracks, to Done, with its reference fix. Run it on the publication branch of
# the project's qa worktree before opening the publication pull request, and put the report in it.
#
#   desktop/tools/play-project.sh <project id>      (the qa worktree is ../<project>-qa)
#
# It syncs desktop/ and the project (repository and qa worktree) to the Windows copy, installs the
# desktop's dependencies there, runs test/real-runtime/play-project.spec.ts and copies its report to
# pr-gate/play-<project>-<time>.md. The run opens the app on the Windows display; Docker Desktop must
# be running. It exits non-zero when any ticket does not reach Done.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
root=$(cd "$here/.." && pwd)
project=${1:-}
if [ -z "$project" ] || [ ! -d "$root/$project-qa/tickets" ]; then
  echo "Usage: tools/play-project.sh <project id>  (needs $root/<project id>-qa with its tickets)" >&2
  exit 1
fi

logs="$here/pr-gate"
mkdir -p "$logs"
stamp=$(date -u +%Y-%m-%dT%H-%M-%SZ)
report="play-$project-$stamp.md"

win_user=$(cd /mnt/c && cmd.exe /d /c "echo %USERNAME%" 2>/dev/null | tr -d '\r')
target=${BUGDETECTIVE_WIN_DEV:-/mnt/c/Users/$win_user/bugdetective-dev}

echo "== sync ($(date -u +%H:%M:%S))"
"$here/tools/sync-windows.sh" "$project" > "$logs/play-sync.log"
echo "== install ($(date -u +%H:%M:%S))"
"$here/tools/win.sh" pnpm install --frozen-lockfile > "$logs/play-install.log" 2>&1
echo "== play $project ($(date -u +%H:%M:%S)); log: pr-gate/play-$project.log"
status=0
BD_WIN_ENV="BD_PLAY_PROJECT=$project
BD_PLAY_QA_DIR=$(wslpath -w "$target/$project-qa")
BD_PLAY_REPORT=$(wslpath -w "$target/desktop/pr-gate/$report")" \
  "$here/tools/win.sh" pnpm exec playwright test -c playwright.real-runtime.config.ts test/real-runtime/play-project.spec.ts \
  > "$logs/play-$project.log" 2>&1 || status=$?

if [ -f "$target/desktop/pr-gate/$report" ]; then
  cp "$target/desktop/pr-gate/$report" "$logs/$report"
  cat "$logs/$report"
  echo "Report: pr-gate/$report"
else
  echo "No report was written; see pr-gate/play-$project.log" >&2
  tail -n 40 "$logs/play-$project.log" >&2
fi
exit $status
