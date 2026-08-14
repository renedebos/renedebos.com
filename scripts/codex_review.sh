#!/usr/bin/env bash
# Run a Codex review of a plan document + the implementation it describes, and
# append the findings to that plan's sibling review log.
#
# Automates the mechanical half of the review loop this project uses: instead of
# hand-running Codex, copying its output into the review file, and pointing
# Claude at it, this does all three. Deciding which findings actually hold is
# still a judgment call for whoever reads them — several Codex suggestions in
# this project have been correctly declined, and a couple of real bugs were only
# caught because claims were checked against the code rather than applied
# wholesale.
#
# Codex runs with -s read-only: it can read the repo and run commands, but
# cannot modify anything. Only this script writes, and only ever by APPENDING to
# the review log — the plan itself is never touched.
#
# Usage:
#   scripts/codex_review.sh <plan-file> [focus]
#
#   plan-file  e.g. plans/player-consolidation/player-consolidation-plan.md
#   focus      what to concentrate on; defaults to the most recent step
#
# Example:
#   scripts/codex_review.sh plans/player-consolidation/player-consolidation-plan.md \
#     "Step 4: player-boot.js and the engine-flag gating"
set -euo pipefail

# Pin the review to THIS worktree. This repo is worked on from several
# worktrees (main, player-consolidation, home-page); relying on the caller's
# cwd risks reviewing a different checkout than the one being edited.
REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

PLAN="${1:?usage: codex_review.sh <plan-file> [focus]}"
FOCUS="${2:-the most recently completed step (the last one marked [x] in the implementation checklist) and its implementation}"

[ -f "$PLAN" ] || { echo "no such plan file: $PLAN" >&2; exit 1; }

# plans/x/x-plan.md -> plans/x/x-codex.md
LOG="${PLAN%-plan.md}-codex.md"
[ "$LOG" != "$PLAN" ] || { echo "plan file must end in -plan.md: $PLAN" >&2; exit 1; }

# One review at a time — two concurrent runs would interleave their appends.
LOCK="$REPO_ROOT/.git/codex-review.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  echo "another codex review is already running (remove $LOCK if stale)" >&2
  exit 1
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"; rmdir "$LOCK" 2>/dev/null || true' EXIT

# Fingerprint the tree so the caller can tell whether the code moved underneath
# a long-running review — a review of a shifting target is worth discarding.
FINGERPRINT_BEFORE="$(git status --porcelain=v1 | sha1sum | cut -c1-12)"

STAMP="$(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "Reviewing $PLAN"
echo "Focus: $FOCUS"
echo "Appending to: $LOG"
echo

codex exec -s read-only --ephemeral -C "$REPO_ROOT" -o "$TMP" "$(cat <<PROMPT
You are reviewing an in-progress engineering plan and the code implementing it,
in this repository. Be rigorous and concrete: this review is read by another
agent that will act on it, so vagueness wastes a cycle.

Plan document: $PLAN
Review log (your previous reviews, for context — do not repeat resolved findings): $LOG

Focus this review on: $FOCUS

Do all of the following:

1. Read the plan document, then read the actual code it describes. Verify the
   plan's claims against the real implementation. Explicitly flag anywhere the
   plan asserts something is done, tested, or safe that the code does not
   support — overclaims in a plan are as damaging as bugs, because later work
   is built on them.
2. Verify by running things, not by assuming. At minimum run the project's
   checks where they exist (e.g. 'python3 scripts/build.py --check', any
   'node scripts/test-*.mjs'). Report what you ran and the result.
3. Look hard for defects the existing tests would NOT catch, especially:
   behavior that regresses versus the code being replaced; work done per-item
   in a loop that should happen once; async ordering and lifecycle/teardown;
   state that can diverge from what the user sees; and assumptions about
   browser/API support that may not hold.
4. Check test quality itself, not just test count: are fixtures faithful to the
   real generated markup/data, or do they encode a convenient fiction? A test
   passing against invented input is worse than no test.

Output format — a single markdown section, no preamble, no restating the plan
back. Start with a level-2 heading naming this review and the date. Then list
findings ordered by severity, each with: a severity label (High / Medium /
Low), a one-line summary, the concrete file:line evidence, why it matters, and
a specific suggested fix. Finish with a short 'Verification during this review'
list of the commands you ran and their results.

If something is genuinely fine, do not pad the review with praise for it. If
you find nothing of substance, say so plainly and briefly — that is a valid
and useful result.
PROMPT
)"

# A crashed/timed-out Codex leaves an empty file; appending that would add a
# blank section that later reviews then read as context.
if [ ! -s "$TMP" ]; then
  echo "codex produced no output — nothing appended to $LOG" >&2
  exit 1
fi

FINGERPRINT_AFTER="$(git status --porcelain=v1 | sha1sum | cut -c1-12)"
if [ "$FINGERPRINT_BEFORE" != "$FINGERPRINT_AFTER" ]; then
  echo
  echo "WARNING: the working tree changed during this review ($FINGERPRINT_BEFORE -> $FINGERPRINT_AFTER)."
  echo "Findings may reference code that has since moved. Re-run if in doubt."
  STALE_NOTE="

> **Note:** the working tree changed while this review ran (\`$FINGERPRINT_BEFORE\` → \`$FINGERPRINT_AFTER\`); verify findings against current code."
else
  STALE_NOTE=""
fi

{
  echo
  echo "---"
  echo
  cat "$TMP"
  printf '%s\n' "$STALE_NOTE"
  echo "_Review generated $STAMP by \`scripts/codex_review.sh\` (codex exec, read-only)._"
} >> "$LOG"

echo
echo "── appended to $LOG ──"
tail -c 2000 "$TMP"
