# The sparse-transient cap (workflow v8)

Opt-in, per show, Rene's call every time:

```bash
python3 scripts/publish_show.py publish <slug> --transient-cap
```

Recorded in provenance as mode `sparse-transient-cap`. The "sparse" is
load-bearing — it keeps the name unmistakably distinct from any future
treatment of repeatedly-loud material, which is a different thing that does
not exist yet.

## Why this is allowed when dynamic-mode gain isn't

The linear-normalization ban exists to stop **gain that follows the music**:
frame-adaptive riding over a timescale of *seconds*, which flattens a
hand-drawn fade or squashes a quiet verse against a loud chorus.

A millisecond-scale true-peak cap on an isolated transient acts three orders
of magnitude below that timescale. It measurably cannot do the harm the ban
exists to prevent, so the original wording ("never a limiter on the music")
over-reached. Rene amended it on 2026-08-08 after evidence, not on principle:

- Loudness-matched blind A/Bs on **two independent shows** —
  `mad-cafe-java-1999-09-09` (Rocky Road; The Kiss / Da Da Da, including its
  hand-drawn fade) and `mad-sweetwater-1999-05-18` (Blahana; Smoke in Heaven;
  The Kiss / Da Da Da).
- Rene could not hear the cap on any of the five, at up to **5.9 dB** of
  recovery.
- Measured LRA moved **≤ 0.3 LU**.

That is the whole evidentiary basis. It covers sparse transients and nothing
else — which is why the gates below are about *sparsity*, and why anything
outside them is declined rather than argued about.

## The three tiers

Revised the same day as the amendment, after the "Hear Me" case showed that
**engagement, not near-peak density, is what the A/B evidence actually
sampled**:

| Tier | Density | Predicted engagement | Longest event | Result |
|---|---|---|---|---|
| **auto** | ≤ 2% | ≤ 1% | ≤ 0.2 s | capped, no gate |
| **review** | ≤ 5% | ≤ 2% | ≤ 0.5 s | capped but **hard-blocked** until Rene listens |
| **declined** | beyond that | | | stays linear-reduced |

Plus a recovery window: at least **1 dB** to be worth doing, at most **6 dB**.
The applause-limiter takes precedence where both would apply.

## The safety gates

These are the real barrier, whether you drive the CLI or `tcap_ui.py`:

- **Listen-flags hard-block the run.** A flagged track aborts the publish
  before anything uploads. Clear it with `--transient-cap-accept N` after
  Rene has actually listened, or drop the track with
  `--transient-cap-exclude N`. Accepting without a listening pass defeats the
  entire gate.
- **Strict −1.00 dBTP post-render assertion**, no QA tolerance for this mode.
  On failure the engine deletes the output and aborts.
- **The 6 dB cap is enforced on the limiter's actual instantaneous
  attenuation** (Rene's disambiguation, same day). A track needing a deeper
  shave gets its gain trimmed instead and lands ≤ ~0.5 dB shy of nominal —
  never over-shaved.
- **Render state is persisted beside each output**, so a resumed run can
  prove its chain or re-render rather than trusting a stale file.

## The per-track flags

| Flag | Meaning |
|---|---|
| `--transient-cap-exclude N` | Rene's veto — this track doesn't get capped |
| `--transient-cap-accept N` | listen-flags reviewed by ear and accepted |
| `--transient-cap-force N` | after listening, override the sparsity gate |
| `--transient-cap-partial N` | allow a full 6 dB shave on a track needing more; lands honestly short of target. **Never automatic** |
| `--transient-cap-max-gr N:dB` | raise the 6 dB ceiling for **one** track after a loudness-matched listening test |

`--transient-cap-max-gr` is an explicit, recorded, per-track exception. It is
not an archive-wide policy change and must never be applied broadly to make a
show hit target.

## What stays banned

- **`loudnorm` dynamic mode**, or any equivalent seconds-scale gain riding.
  No exceptions.
- **Frequent or sustained limiting of repeatedly-loud material** — a dominant
  snare on every backbeat. The canonical counterexample is `Truck` on Cafe
  Java at 12.3% near-peak. This regime has **no listening evidence** behind
  it. A `drum-control` proposal exists in `codex-notes.md` and is
  deliberately **not built**; it would need its own decision from Rene with
  its own A/B evidence.

## Provenance and the public page

Full guardrail data — max and p95 reduction, engaged %, event count, longest
event, source LRA — is surfaced in `/archive-data/`.

One outstanding item: `/process/` still states the archive uses "linear gain
only." Once a transient-capped show actually ships, that page needs a caveat
sentence, because the public claim would otherwise contradict the archive's
own recorded provenance. Flag this to Rene rather than editing `/process/`
unprompted — the wording is his.
