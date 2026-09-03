# T-017 — L3 check `dedup.v1` (implementation; enablement gated by FD-1)

**Tier:** STRONG implementation. **FRONTIER gate FD-1** before the check may
emit `fail` or block L3. Until FD-1 closes, `config/checks.json` has
`dedup.v1: { blocking: false, emit_fail: false }` and the check emits
`pass`/`inconclusive` only.

## Objective
Decide whether an episode's state trajectory is a duplicate or jittered
replay of any previously logged episode (all orgs), and emit a claim with
nearest-neighbour evidence and the thresholds used.

## Dependencies
T-036 (episodes + files), T-020 (issuance), T-011 (`readEpisodeFrames`).

## Files
- Create `services/verify/src/checks/dedup.ts`, `src/index/trajectory-index.ts` (SQLite LSH tables), `test/dedup.test.ts`, `test/fixtures/trajectories/` (synthetic: 200 distinct, 20 exact dups, 20 jittered σ ∈ {0.5°, 1°, 2°}, 20 time-warped ±10 %), `config/checks.json`.

## Parameter classes (PLAN §10.9)
| Parameter | Class | Value |
| --- | --- | --- |
| check id 0x0001, result codes | protocol constant | fixed |
| resample rate 10 Hz; DCT coefficients 8/joint; velocity bins 32; LSH 16 planes × 8 tables; DTW band 10 %; candidates 50 | implementation detail (`check_version: "dedup.v1.0"`) | fixed here |
| `T_exact`, `T_near` | configuration (FD-1) | provisional 0.02 / 0.05 normalised; **recorded in every claim's `detail.thresholds`** |
| fingerprint design | research variable | changes bump `check_version` |

## Algorithm (fixed)
1. Load `observation.state` (N×D) via `readEpisodeFrames`; resample to 10 Hz (linear); normalise per joint by embodiment joint range when known, else per-episode min/max (record `normalisation` in detail).
2. Fingerprint `f` = per-joint 32-bin velocity histogram ‖ first 8 DCT-II coefficients per joint.
3. Candidates: cosine-LSH over `f` → ≤ 50 from the index restricted to the same embodiment id.
4. `d = DTW_band10%(a, b) / (len_a + len_b)`.
5. `d < T_exact` → `fail` (if `emit_fail`) else `inconclusive`; `T_exact ≤ d < T_near` → `inconclusive`; else `pass`. `detail = { check_version, thresholds, normalisation, nearest: {leaf, d} | null, candidates_considered, index_snapshot }`.
6. Insert `f` after deciding.

## Expected behaviour (fixture targets, reported in `REPORTS.md` for FD-1)
Exact dups 100 % under `T_exact`; σ ≤ 1° ≥ 95 %; time-warp ±10 % ≥ 90 %; distinct ≤ 1 % under `T_near`.

## Edge cases
Episodes < 1 s; D mismatch (skip, `inconclusive`); NaNs (`inconclusive`).

## Tests
Fixture ROC; determinism; index round-trip; `emit_fail=false` never yields `fail`.

## Acceptance
Tests green; ROC numbers reported; claims carry thresholds (I-15).

## Security
Known evasions (re-timing beyond band, joint remap) documented in `docs/VERIFICATION.md`. Evidence, not proof (I-1).
