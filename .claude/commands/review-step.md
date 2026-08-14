---
description: Run a Codex review of the current plan step and report which findings hold — stops before changing anything
---

Run the Codex review loop and report. **Do not implement anything in this
command** — `/apply-review` does that, after the human has seen the findings.

Arguments (optional): `$ARGUMENTS` — what to focus on. Defaults to the step just
completed. May name a different plan file as the first word.

## Steps

1. **Run the review and wait for it to finish.** Default plan file is
   `plans/player-consolidation/player-consolidation-plan.md`:

   ```
   bash scripts/codex_review.sh <plan-file> "<focus>"
   ```

   It takes several minutes. **Do not edit any file in this worktree while it
   runs** — the script fingerprints the tree and will flag a review whose code
   moved underneath it, but the cleanest answer is simply not to touch anything.
   Read code if useful; write nothing.

2. **Read the appended findings.**

3. **Verify each finding against the actual code.** This is the whole point of
   the command. For every finding, check the claim yourself: read the file, run
   the test, grep for the caller. Findings here have been a mix of genuine
   defects, things already handled, and claims that turned out to be factually
   wrong about the repo's state — so trace, don't trust.

4. **Record the disposition in the review log.** Append a short
   `### Disposition (Claude, <date>)` block under the new review listing each
   finding as **confirmed**, **declined** (with the reason), or **already
   handled** (with evidence). Without this, later reviews re-raise settled
   points, because the log otherwise shows only what Codex claimed and never
   what came of it.

5. **Report and stop.** Summarize what was confirmed, what you're declining and
   why, and what you'd change if approved. Do not edit source files, do not
   update the plan's checklists, and do not start the next step.
