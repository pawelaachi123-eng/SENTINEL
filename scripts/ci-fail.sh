#!/usr/bin/env bash
# Failure report that survives a blocked log CDN:
#   1. annotations (readable over the check-runs API)
#   2. job summary
#   3. the log itself pushed to the scratch branch "ci-logs" (readable over git)
# usage: scripts/ci-fail.sh <logfile> <label>
set -uo pipefail
LOG="${1:-/tmp/build.log}"
LABEL="${2:-build}"
HERE="$(cd "$(dirname "$0")" && pwd)"

bash "$HERE/ci-annotate.sh" "$LOG" "$LABEL" || true

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### ${LABEL} failed"
    echo '```'
    tail -n 120 "$LOG" 2>/dev/null || echo "(no log)"
    echo '```'
  } >> "$GITHUB_STEP_SUMMARY"
fi

mkdir -p ci-logs
SLUG="$(echo "$LABEL" | tr ' /' '--')"
cp "$LOG" "ci-logs/${SLUG}.log" 2>/dev/null || echo "no log file" > "ci-logs/${SLUG}.log"
git config user.name "sentinel-ci" 2>/dev/null || true
git config user.email "ci@sentinel.invalid" 2>/dev/null || true
git add -f ci-logs >/dev/null 2>&1 || true
git commit -qm "ci: ${LABEL} failure log" >/dev/null 2>&1 || true
git push -q --force origin "HEAD:refs/heads/ci-logs" >/dev/null 2>&1 || echo "could not push ci log"
exit 1
