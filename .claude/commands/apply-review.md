---
description: Implement the findings confirmed by the most recent /review-step, then re-verify
---

Implement the findings that `/review-step` confirmed. Run this only after the
human has seen those findings and approved acting on them.

Arguments (optional): `$ARGUMENTS` — restrict to specific findings, e.g.
"only 1 and 3". Default: everything marked **confirmed** in the latest
`### Disposition` block of the review log.

## Steps

1. **Re-read the latest review and its disposition block** so you act on the
   agreed list, not a remembered one.

2. **Fix each confirmed finding.** For anything behavioral, add a regression
   test — and prove the test earns its place by confirming it FAILS without the
   fix before restoring it. A test that passes either way is worse than none:
   this project has already shipped one that passed for the wrong reason.

3. **Update the plan document** to match reality: mark completed work, correct
   anything the review showed to be an overclaim, and record notable decisions
   (including declines) so they are not re-litigated.

4. **Re-verify and report actual results, including failures:**
   ```
   python3 scripts/build.py --check
   python3 scripts/build.py          # also runs the generated-markup check
   for f in scripts/test-*.mjs; do node "$f"; done
   ```

5. **Update the disposition block** to mark each finding fixed, and report what
   changed. Stop there — do not start the next step of the plan.
