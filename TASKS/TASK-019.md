# T-019 — L3 checks `sensor_consistency.v1` and `sim_signature.v1` (indicative; FD-2)

**Tier:** STRONG implementation; **FRONTIER gate FD-2** for thresholds.
Both checks are `blocking: false, emit_fail: false` until FD-2 closes;
`sim_signature.v1` stays indicative (never blocks L3) in v2 regardless.

## Objective
(a) Does video motion correlate with proprioceptive motion? (b) Does data
declared `real` carry simulation signatures?

## Dependencies
T-036, T-020, T-011; ffmpeg present (skip loudly otherwise).

## Files
- Create `services/verify/src/checks/sensor_consistency.ts`, `src/checks/sim_signature.ts`, `src/video/motion.ts` (ffmpeg frame-difference energy at 5 fps over the episode's `range.video` window: `-ss t0 -to t1 -vf "fps=5,format=gray,tblend=all_mode=difference" -f rawvideo` → mean abs per frame), tests + fixtures.

## Rules (fixed algorithm; thresholds configuration)
- `sensor_consistency.v1`: `s(t)` = joint-speed norm at 5 Hz; `m(t)` = motion energy; Pearson `ρ`. Thresholds `ρ_pass` (prov. 0.4), `ρ_fail` (prov. 0.2) recorded in detail. No video → `inconclusive`.
- `sim_signature.v1` features: (1) exact-repeat fraction of state floats beyond quantisation; (2) zero Δt variance; (3) spectral power > 5 Hz < 1e-6 of total; (4) zero frame-difference energy on ≥ 20 % of frames. `score` = features tripped; `score_inconclusive` (prov. 2), `score_fail` (prov. 3). `source == "sim"` → `pass` with note.

## Tests
Fixtures: moving/still video mismatch; sim-like vs real-like trajectories; ffmpeg-absent path skips with a named reason.

## Acceptance
Checks run in the pipeline with `emit_fail=false`; `docs/VERIFICATION.md` lists evasions.

## Security
Defeatable heuristics; wording via T-021 only.
