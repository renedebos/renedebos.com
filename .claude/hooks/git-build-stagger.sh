#!/usr/bin/env bash
# PreToolUse hook (Bash matcher): warns before a git commit/push or make build
# if another one just ran in this repo — Rene runs multiple Claude Code
# sessions against the same working directory (e.g. long-running audio
# processing in one, player/layout work in another), and staggering these
# commands avoids a git push race or a `make build` clobbering the other
# session's generated assets/ output.
set -euo pipefail

input=$(cat)

python3 - "$input" <<'PYEOF'
import json
import re
import sys
import time

payload = json.loads(sys.argv[1])
cmd = payload.get("tool_input", {}).get("command", "") or ""

pattern = re.compile(
    r'(^|[;&|]|&&|\|\|)\s*(git\s+commit|git\s+push|make\s+build)(\s|$)'
)
if not pattern.search(cmd):
    sys.exit(0)

lock = "/tmp/renedebos-git-build.lock"
now = time.time()
threshold = 300

try:
    with open(lock) as f:
        last = float(f.read().strip())
except (FileNotFoundError, ValueError):
    last = None

if last is not None:
    elapsed = now - last
    if elapsed < threshold:
        wait = int(threshold - elapsed)
        reason = (
            f"Another git commit/push or make build ran {int(elapsed)}s ago in this "
            "repo — possibly a different Claude Code session (e.g. audio processing "
            f"vs. player/layout work). Stagger by ~{wait}s to avoid a git push race "
            "or a make build clobbering the other session's assets/ output. If "
            "you've confirmed the other session is idle, proceed."
        )
        print(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "ask",
                "permissionDecisionReason": reason,
            }
        }))
        sys.exit(0)

with open(lock, "w") as f:
    f.write(str(now))
PYEOF
