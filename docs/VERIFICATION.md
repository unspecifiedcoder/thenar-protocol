# Verification checks

Normative source: `PLAN.md` §10.9 (check ids and parameter classes), §9.3
(`VerificationClaim v1`), §5 I-15 (thresholds and versions always recorded
in `detail`). This document explains what each check does and its known
evasions (§22 "evidence, not proof"); it does not redefine anything §10.9
already fixes.

Every claim's `detail` carries `check_version` and `thresholds` — a claim
without them is invalid (I-15). Config-class parameters (`enabled`,
`blocking`, `emit_fail`, and any per-check `thresholds`) live in
`config/checks.json`; a check whose thresholds are not yet FRONTIER-approved
emits only `pass`/`inconclusive`, never `fail`, and is `blocking: false`
(§10.9).

## `dedup.v1` (id `0x0001`, T-017)

**Status: FD-1 open** (`TASKS/CONFLICTS.md`). `config/checks.json` pins
`dedup.v1: { enabled: true, blocking: false, emit_fail: false, thresholds:
{ T_exact: 0.02, T_near: 0.05 } }`. A would-be `fail` (`d < T_exact`) is
downgraded to `inconclusive` with `detail.downgraded_from: "fail"` — this
check never emits `fail` while FD-1 is open, structurally (both via the
config flag and a code-level guard in `dedupCheck`), regardless of who
calls it.

### Objective

Decide whether an episode's `observation.state` trajectory is a duplicate
or jittered/re-timed replay of any previously logged episode of the same
embodiment (all orgs), and record nearest-neighbour evidence.

### Algorithm (implementation detail — PLAN §10.9; changes bump `check_version`)

1. Load `observation.state` (N x D, via `readEpisodeFrames`,
   `services/api/src/ingest/lerobot.ts`). Reject (`inconclusive`) frames
   that are empty, ragged, non-finite, not strictly time-ordered, or
   shorter than 1 s in duration.
2. Normalise each joint column to `[0, 1]`: by the embodiment's
   `jointLimits` (`packages/protocol/src/embodiments.ts`) when its length
   matches the episode's DOF, else by the episode's own per-joint
   min/max. A DOF mismatch against a known embodiment's `jointLimits` is
   `inconclusive` (`reason: "joint count mismatch"`) rather than silently
   falling back to min/max — the two normalisations are not comparable
   against an index built the other way. The method and per-joint ranges
   used are recorded in `detail.normalisation`.
3. Resample the normalised trajectory onto a fixed 10 Hz grid by linear
   interpolation, spanning `[timestamp[0], timestamp[last]]`.
4. Candidate retrieval: cosine-LSH (16 random hyperplanes x 8 tables,
   fixed seed, `services/verify/src/index/trajectory-index.ts`) over a
   per-joint 32-bin velocity histogram ‖ first 8 DCT-II coefficients
   descriptor of the resampled trajectory, restricted to
   `traj_fingerprint.embodiment = <this episode's embodiment>`, capped at
   50 candidates, excluding the episode's own leaf (an episode is never
   compared to itself).
5. Refinement: banded DTW (Sakoe-Chiba band = `max(10% * max(len_a,
   len_b), |len_a - len_b|)`, Euclidean per-frame local cost) between the
   querying episode's resampled trajectory and each candidate's stored
   one; `d = DTW / (len_a + len_b)`. The nearest candidate by `d` is kept.
6. Decision: `d < T_exact` -> `fail` if `emit_fail`, else `inconclusive`
   with `downgraded_from: "fail"`; `T_exact <= d < T_near` ->
   `inconclusive`; otherwise `pass`.
7. Insert the resampled trajectory into the index (`TrajectoryIndex.insert`)
   only after the decision is made, keyed by this episode's leaf hash.

`detail` also carries `nearest: {leaf, d} | null`, `candidates_considered`,
and `index_snapshot` (the index's row count at decision time, monotonically
increasing).

### Why the index stores the trajectory, not just a fingerprint

`traj_fingerprint(leaf, embodiment, dof, frames, f)` — `f` is the resampled,
normalised trajectory itself (flattened float32, `frames x dof`), not only
the LSH descriptor. The LSH descriptor (histogram ‖ DCT) is recomputed from
`f` on the fly wherever it's needed (insert and query); DTW is run directly
on `f`. A schema that stored only the fixed-size descriptor would have
nothing for DTW to align — DTW needs the two time series, not their
bucketed summary. See `services/verify/src/index/schema.sql` for the same
note in context.

### Fixture ROC (`services/verify/test/dedup.test.ts`, seeded PRNG, `franka_panda`)

Reported for FD-1 (measured, not hand-tuned to hit the targets exactly):

| Metric | Target (TASK-017.md) | Measured |
| --- | --- | --- |
| Exact dups under `T_exact` | 100% | 100.0% (20/20) |
| Jittered sigma <= 1 deg under `T_near` | >= 95% | 92.9% (13/14) |
| Time-warped +-10% under `T_near` | >= 90% | 95.0% (19/20) |
| Distinct pairs under `T_near` (false positives) | <= 1% | 0.00% (0/199) |

(Jittered, all three sigmas {0.5,1,2} deg combined: 90.0% (18/20) under
`T_near`.) Re-run: `pnpm test:verify` (prints the same table).

### Known evasions (§22: evidence, not proof)

- **Re-timing beyond the DTW band.** The band is 10% of the longer
  sequence's length; a replay stretched or compressed by more than that
  (well beyond typical playback-speed variation) can fall outside the
  alignment the DTW search explores and be missed.
- **Joint remap / relabelling.** The check assumes the episode's joint
  order matches the embodiment's declared order (same order as
  `jointLimits`). A replay whose channels are permuted, or padded/dropped
  to a different apparent DOF, is not detected as a duplicate — it is
  either misnormalised or rejected as a DOF mismatch, not matched.
- **Per-frame perturbation beyond the fixture's jitter range.** Noise
  large enough to move `d` past `T_near` (well beyond the sigma <= 2 deg
  the fixtures exercise) reads as a distinct episode.
- **Different embodiment id, same physical motion.** Candidate retrieval
  is restricted to the same declared `embodiment` string; relabelling the
  embodiment on an otherwise-identical trajectory removes it from the
  comparison pool entirely.
- **LSH false negatives.** Cosine-LSH is probabilistic; a true near-duplicate
  can, with some probability, land in none of the 8 tables' matching
  buckets and never reach the DTW refinement stage at all. The fixture ROC
  above is the empirical measurement of this on the exercised distributions,
  not a proof of a false-negative bound.

## `timing.v1` (id `0x0002`) and `kinematics.v1` (id `0x0003`, T-018)

`blocking: true, emit_fail: true` in `config/checks.json` — these are
deterministic rule checks, not thresholds pending FRONTIER review.
`timing.v1`: `timestamp` strictly increasing; `|dt - 1/rate_hz| <=
0.25/rate_hz` for >= 99% of frames; no gap > `5/rate_hz`; frame count
within +-2 of `duration_ms * rate_hz / 1000`. `kinematics.v1`: per-joint
range (tolerance 1 degree), finite-difference velocity <= `maxVel[j]`,
acceleration spikes > 50 rad/s^2 flagged, for embodiments with recorded
`jointLimits`/`maxVel`; `inconclusive` otherwise. See
`services/verify/src/checks/timing.ts` and `.../kinematics.ts` for the
exact rules and `detail` fields.

## `sensor_consistency.v1` (id `0x0004`) and `sim_signature.v1` (id `0x0005`, T-019)

**Status: FD-2 open** (`TASKS/CONFLICTS.md`). `config/checks.json` pins both
`enabled: true, blocking: false, emit_fail: false`. Both checks
unconditionally downgrade a would-be `fail` to `inconclusive` with
`detail.downgraded_from: "fail"` — a code-level guard (not just the config
flag), mirroring `dedup.v1`'s FD-1 downgrade. `sim_signature.v1` stays
indicative only — never blocking L3 — in v2 regardless of FD-2's outcome
(`TASKS/CONFLICTS.md`).

`ffmpeg` is not installed in this environment (this task's supervisor
adjustment): both checks are pure functions taking a pre-computed
`motion: number[] | null` (`src/checks/sensor_consistency.ts`,
`src/checks/sim_signature.ts`), so they and their tests never touch
`ffmpeg` at all. The motion itself comes from an injectable
`MotionEnergyProvider` (`src/video/motion.ts`): `FfmpegMotionEnergy` is the
real implementation, exercised only by production wiring
(`src/run.ts:computeMotion`), never by `pnpm test:verify` here; tests use an
in-memory fake. When `ffmpeg`/`ffprobe` can't be run (missing binary, spawn
failure, non-zero exit, unparseable output), `FfmpegMotionEnergy` throws a
typed `FfmpegUnavailable`, which `src/run.ts` catches and turns into a loud
skip: `sensor_consistency.v1` comes back `inconclusive` with
`detail.reason = "ffmpeg unavailable"` (its existing "no video" path,
motion is `null`), and `sim_signature.v1` keeps whatever its other three
features produce, annotated with `detail.ffmpeg_error = "ffmpeg
unavailable"`.

### `sensor_consistency.v1`

**Objective:** does video motion correlate with proprioceptive motion? A
real episode's joint speed and its camera's frame-difference motion energy
should move together; a mismatch is evidence of a mislabeled or synthetic
recording.

**Algorithm** (TASK-019.md "Rules", fixed): `s(t)` = joint-speed norm —
finite-difference velocity of `observation.state` at the episode's own
timestamps, L2-normed across joints, linearly resampled onto the 5 Hz grid
`motion` was sampled on (`t0 + k/5`, `t0` = the episode's first timestamp,
matching the video window `src/run.ts` passed to the motion provider).
`m(t)` = motion energy, passed in directly. Pearson `ρ` between the two.
`ρ >= ρ_pass` (prov. `0.4`) -> `pass`; `ρ < ρ_fail` (prov. `0.2`) -> `fail`
(downgraded per FD-2); otherwise `inconclusive`. No video (`motion ===
null`) -> `inconclusive` (`detail.reason = "no video"`). A constant `s(t)`
or `m(t)` (zero variance — Pearson undefined) -> `inconclusive`
(`detail.reason = "degenerate variance"`), never treated as either extreme.
`detail = { check_version: "sensor_consistency.v1.0", thresholds, rho,
samples }` (`downgraded_from` added when applicable).

**Known evasions (§22: evidence, not proof):**
- A replay that dubs an unrelated, but similarly-timed, video clip over a
  real joint trajectory (or vice versa) can land `ρ` in the mid-band and
  read as `inconclusive` rather than a clear mismatch.
- Camera framing that keeps the moving parts out of frame (or a camera
  aimed at a fixed background while a different, unfilmed arm executes the
  motion) produces a low-variance `m(t)` that is `inconclusive`, not a
  flagged mismatch.
- The correlation is a single scalar over the whole episode; a trajectory
  that is genuine for most of its duration but substitutes a mismatched
  clip for a short segment can still average to a passing `ρ`.
- `t0` is taken from the episode's own first `timestamp`, not from an
  independently verified video start; a manifest that misdeclares the
  video/data alignment shifts both series together in ways this check
  cannot detect from the data alone.

### `sim_signature.v1`

**Objective:** does data declared `real` carry simulation signatures?

**Algorithm** (TASK-019.md "Rules", fixed features; per-feature trip
thresholds not named by the task are this implementation's documented
"implementation detail"-class choice, recorded in `check_version` and
`detail.features`, not `detail.thresholds` — that field is reserved for the
FD-2-gated `score_*` pair): four independent features, each contributing at
most 1 to `score`:
1. **Exact-repeat fraction of state floats beyond quantisation** — fraction
   of `(frame, joint)` scalar deltas that are exactly `0`; trips above
   `0.05`.
2. **Zero Δt variance** — population variance of consecutive `timestamp`
   deltas; trips below `1e-12`.
3. **Spectral power above 5 Hz** — fraction of the joint-speed-norm
   signal's total DFT power (direct DFT, rectangular window, uniformly
   resampled at 20 Hz) at frequencies > 5 Hz; trips below `1e-6`
   (TASK-019.md's own figure). **Known limitation:** a rectangular-window
   DFT over a signal whose duration isn't an exact integer number of
   cycles leaks a non-negligible fraction of genuinely sub-5Hz power into
   higher bins, so in practice this feature reliably trips only for
   near-static or exactly window-periodic signals — it rarely fires on its
   own for arbitrary smooth low-frequency motion and is redundant with the
   other three rather than a strong independent signal.
4. **Zero frame-difference energy on >= 20% of frames** — from `motion`;
   fraction of frames whose energy is exactly `0`; trips at `>= 0.20`
   (TASK-019.md's own figure). Skipped (not counted toward `score`, `motion
   === null`; `sim_signature.v1` does not gate its whole result on video's
   absence the way `sensor_consistency.v1` does).

`score` = count of tripped features (of those evaluated). `score >=
score_fail` (prov. `3`) -> `fail` (downgraded per FD-2, and stays
indicative regardless — see above); `score >= score_inconclusive` (prov.
`2`) -> `inconclusive`; else `pass`. `source === "sim"` -> `pass`
unconditionally with `detail.note = "declared sim"` (a declared simulation
is not being asked whether it looks synthetic); `"mixed"` is treated like
`"real"` (no free pass). `detail = { check_version: "sim_signature.v1.0",
thresholds: { score_inconclusive, score_fail }, score, features: [{ name,
value, tripped }, …] }` (`downgraded_from` added when applicable).

**Known evasions (§22: evidence, not proof):**
- The `score` thresholds treat all four features as equally weighted votes;
  a genuinely synthetic recording engineered to avoid exactly one or two of
  the four artifacts (e.g. injected per-frame float noise to defeat feature
  1, jittered timestamps to defeat feature 2) stays under `score_fail` (or
  even `score_inconclusive`) despite being simulated.
- Feature 3 (spectral power) is, per its documented limitation above, weak
  in practice — a well-tuned simulator that adds any broadband dithering
  to its output evades it easily, and honest real data with an unlucky
  window length can leak power in the other direction.
- Feature 4 depends entirely on the paired `sensor_consistency.v1`/`motion`
  pipeline's camera and window choice; a video with any per-frame
  compression noise (most real codecs) never reads as exactly zero, so
  this feature under-fires on borderline near-static real footage just as
  readily as it fires on true renders.
- All four features operate on a single episode in isolation; a simulator
  whose output statistically resembles real per-frame noise (matched
  quantisation, matched timing jitter, matched spectral content) is not
  something any of these four heuristics is designed to catch.

## `attestation.v1` (id `0x0006`)

**Status: FD-3, Phase D.** Not yet scheduled; not listed in
`config/checks.json` (that file currently covers the five checks whose
work is in flight — `0x0001`-`0x0005`).
