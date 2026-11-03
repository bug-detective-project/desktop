#!/usr/bin/env bash
# Opens a pull request into main only after the suites that need the real runtime pass on the
# Windows side (Docker Desktop, VS Code, the Windows toolchain): the e2e tests on Windows and
# test/real-runtime (the whole game loop through the real UI). Those suites cannot run on GitHub's
# hosted runners, so this script is the gate: no pull request without a green run of them.
#
#   desktop/tools/open-pr.sh --title "<type>(<scope>): <subject>" --body-file <file>
#
# Logs stay in pr-gate/ (git-ignored; never under test-results/, which Playwright empties when a
# suite starts). Set BUGDETECTIVE_INSTALLED_EXE on the Windows side
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
while [ $# -gt 0 ]; do
  case $1 in
    --title) title=$2; shift 2 ;;
    --body-file) body_file=$2; shift 2 ;;
    *) echo "Unknown argument: $1" >&2; exit 1 ;;
  esac
done
if [ -z "$title" ] || [ -z "$body_file" ]; then
  echo "Usage: tools/open-pr.sh --title <title> --body-file <file>" >&2
  exit 1
fi

"$here/tools/sync-windows.sh"
run_gate install pnpm install --frozen-lockfile
run_gate e2e-windows pnpm run test:e2e
run_gate real-runtime pnpm run test:real-runtime

e2e_summary=$(grep -E '^\s+[0-9]+ passed' "$logs/e2e-windows.log" | tail -n 1 | xargs)
rr_summary=$(grep -E '^\s+[0-9]+ passed' "$logs/real-runtime.log" | tail -n 1 | xargs)
gate="Pull request gate (tools/open-pr.sh) on $stamp: e2e on Windows $e2e_summary; real-runtime suite $rr_summary."
echo "$gate"

git -C "$here" push -u origin "$branch"
gh pr create --base main --head "$branch" --title "$title" --body "$(cat "$body_file"; printf '\n%s\n' "$gate")"
