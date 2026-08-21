#!/usr/bin/env bash
# PreToolUse hook (Bash matcher): warns before a git commit/push or make build
# if another one just ran in this repo — Rene runs multiple Claude Code
# sessions against the same working directory (e.g. long-running audio
# processing in one, player/layout work in another), and staggering these
# commands avoids a git push race or a `make build` clobbering the other
# session's generated assets/ output.
set -euo pipefail

input=$(cat)

# Pick a working Python. On Windows `python3` resolves to the Microsoft Store
# alias stub: it exists, so `command -v python3` finds it, but every invocation
# exits non-zero without running anything. Probe by executing each candidate
# rather than by presence.
PY=""
for cand in python3 python py; do
  if "$cand" -c "" >/dev/null 2>&1; then PY="$cand"; break; fi
done
# No usable interpreter — fail open rather than block the tool call.
[ -n "$PY" ] || exit 0

"$PY" - "$input" <<'PYEOF'
import json
import os
import re
import sys
import tempfile
import time

payload = json.loads(sys.argv[1])
cmd = payload.get("tool_input", {}).get("command", "") or ""

pattern = re.compile(
    r'(^|[;&|]|&&|\|\|)\s*(git\s+commit|git\s+push|make\s+build)(\s|$)'
)
if not pattern.search(cmd):
    sys.exit(0)

# Keep the literal /tmp on the Chromebook — every session must agree on one
# path or the stagger guard silently stops seeing the other session. Only
# Windows diverges, where a native-Python "/tmp/..." resolves to a nonexistent
# C:\tmp and fails to write.
_tmp = "/tmp" if os.path.isdir("/tmp") else tempfile.gettempdir()
lock = os.path.join(_tmp, "renedebos-git-build.lock")
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
