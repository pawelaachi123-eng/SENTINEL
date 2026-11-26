#!/usr/bin/env bash
# Turn the tail of a build log into GitHub annotations.
#
# The runner's raw logs live on a CDN that some environments cannot reach, but
# check-run annotations come back over the normal API — so on failure we push the
# interesting part of the log through the annotation channel.
#
# usage: scripts/ci-annotate.sh <logfile> [label]
set -uo pipefail

LOG="${1:-/tmp/build.log}"
LABEL="${2:-build}"

if [ ! -s "$LOG" ]; then
  echo "::error::${LABEL} failed with no log output"
  exit 0
fi

# Escape for the workflow-command protocol, then split into ~3500 char chunks.
python3 - "$LOG" "$LABEL" <<'PY'
import sys

path, label = sys.argv[1], sys.argv[2]
with open(path, 'r', errors='replace') as handle:
    lines = handle.read().splitlines()

tail = lines[-400:]
text = "\n".join(tail)
# Prefer the region around the first error if the log is long.
for index, line in enumerate(tail):
    low = line.lower()
    if 'error:' in low or 'error ' in low or 'failed' in low or 'exception' in low:
        text = "\n".join(tail[max(0, index - 8): index + 60])
        break

escaped = text.replace('%', '%25').replace('\r', '').replace('\n', '%0A')

chunk = 3800
for start in range(0, min(len(escaped), chunk * 3), chunk):
    print(f"::error title={label}::{escaped[start:start + chunk]}")
print(f"::warning title={label}::log length {len(text)} characters")
PY
