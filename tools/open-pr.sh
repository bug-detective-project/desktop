#!/usr/bin/env bash
# Opens (or updates) a pull request into main.
#
#   desktop/tools/open-pr.sh --title "<type>(<scope>): <subject>" --body-file <file> [--skip-real-runtime]
#
# The script first runs, on the Windows side (Docker Desktop, VS Code, the Windows toolchain),
# test/real-runtime (the whole game loop through the real UI, about 5 minutes) and, when the branch
# changes what differs on Windows (the renderer, the preload, the platform layer, the e2e tests or
# the build configuration), the e2e tests on Windows too (about 8 minutes); nothing is pushed unless
# they pass. The CI runs the rest: unit tests, stories, integration tests on real Docker and e2e
# tests under Xvfb (.github/workflows/ci.yml), plus the pre-push hook.
# --skip-real-runtime is for a pull request the suite cannot speak to: the body must say why, in a
# line starting with "Real-runtime skipped:". Never for a version tagged for players.
# When the branch already has an open pull request, the script pushes and comments the result on it
# instead of creating another. Logs stay in pr-gate/ (git-ignored; never under test-results/, which
# Playwright empties when a suite starts). Set BUGDETECTIVE_INSTALLED_EXE on the Windows side
# (BD_WIN_ENV="BUGDETECTIVE_INSTALLED_EXE=...") to include the installed-app spec.
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
logs="$here/pr-gate"
mkdir -p "$logs"
stamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

branch=$(git -C "$here" branch --show-current)
if [ "$branch" = "main" ] || [ -z "$branch" ]; then
  echo "Open the pull request from a work branch, not from main." >&2
  exit 1
fi
if [ -n "$(git -C "$here" status --porcelain)" ]; then
  echo "Commit or discard the working tree changes first." >&2
  exit 1
fi

run_gate() {
  local name=$1
  shift
  echo "== $name ($(date -u +%H:%M:%S))"
  mkdir -p "$logs"
  if "$here/tools/win.sh" "$@" > "$logs/$name.log" 2>&1; then
    echo "   passed; log: pr-gate/$name.log"
  else
    echo "   FAILED; log: pr-gate/$name.log" >&2
    tail -n 40 "$logs/$name.log" >&2
    exit 1
  fi
}

title=""
body_file=""
real_runtime=true
while [ $# -gt 0 ]; do
  case $1 in
    --title) title=$2; shift 2 ;;
    --body-file) body_file=$2; shift 2 ;;
    --skip-real-runtime) real_runtime=false; shift ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done
if [ -z "$title" ] || [ -z "$body_file" ]; then
  echo "Usage: tools/open-pr.sh --title <title> --body-file <file> [--skip-real-runtime]" >&2
  exit 1
fi
if ! $real_runtime && ! grep -qE '^Real-runtime skipped: .+' "$body_file"; then
  echo '--skip-real-runtime needs a line starting with "Real-runtime skipped:" in the body.' >&2
  exit 1
fi

if $real_runtime; then
  git -C "$here" fetch --quiet origin main
  changed=$(git -C "$here" diff --name-only "origin/main...HEAD")
  if printf '%s\n' "$changed" | grep -qE '^(src/renderer/|src/preload/|src/main/platform/|test/e2e/|package\.json$|pnpm-lock\.yaml$|electron\.vite\.config|playwright\.config)'; then
    with_e2e=true
  else
    with_e2e=false
  fi

  "$here/tools/sync-windows.sh"
  run_gate install pnpm install --frozen-lockfile
  if $with_e2e; then
    run_gate e2e-windows pnpm run test:e2e
    e2e_summary="e2e on Windows $(grep -E '^\s+[0-9]+ passed' "$logs/e2e-windows.log" | tail -n 1 | xargs)"
  else
    e2e_summary="e2e on Windows skipped (no renderer, preload, platform, e2e or build changes; the CI heavy job runs them on Linux)"
  fi
  run_gate real-runtime pnpm run test:real-runtime
  rr_summary=$(grep -E '^\s+[0-9]+ passed' "$logs/real-runtime.log" | tail -n 1 | xargs)
  gate="Pull request gate (tools/open-pr.sh) on $stamp: $e2e_summary; real-runtime suite $rr_summary."
else
  gate="Pull request gate (tools/open-pr.sh) on $stamp: real-runtime suite skipped, see the reason above; the CI runs the unit, stories, integration and e2e suites."
fi
echo "$gate"

git -C "$here" push -u origin "$branch"
existing=$(gh pr list --head "$branch" --state open --json number --jq '.[0].number')
if [ -n "$existing" ]; then
  gh pr comment "$existing" --body "$gate"
  echo "Updated pull request #$existing"
else
  gh pr create --base main --head "$branch" --title "$title" --body "$(cat "$body_file"; printf '\n%s\n' "$gate")"
fi
