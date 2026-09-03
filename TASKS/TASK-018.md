# T-018 — L3 checks `timing.v1` and `kinematics.v1`

**Tier:** STRONG. Deterministic rule checks over parquet data; rules fixed
here.

## Objective
Two checks: timestamps are consistent with the declared rate; joint states
and their derivatives are physically plausible for the declared embodiment.

## Dependencies
T-011, T-020.

## Files
- Create `services/verify/src/checks/timing.ts`, `src/checks/kinematics.ts`, tests with synthetic fixtures (clean; dropped frames; duplicated timestamps; teleporting joints; out-of-range joints).
- Modify `packages/protocol/src/embodiments.ts`: add optional `jointLimits?: [number, number][]`, `maxVel?: number[]` (rad/s) for at least `franka_panda`, `so_arm100`, `ur5e`, `viperx300`, `widowx250` (values from the Menagerie MJCF `range` and reasonable velocity caps; cite the file in a comment).

## Rules
- `timing.v1`: `timestamp` strictly increasing; `|Δt − 1/rate_hz| ≤ 0.25/rate_hz` for ≥ 99 % of frames; no gap > 5/rate_hz; frame count within ±2 of `duration_ms · rate_hz / 1000`. Any violated → `fail`, with the first offending frame in `detail`.
- `kinematics.v1`: for embodiments with limits: every `observation.state[j]` within `jointLimits[j]` (tolerance 1°); finite-difference velocity ≤ `maxVel[j]`; acceleration spikes (> 50 rad/s²) flagged; `action` within limits. Missing limits → `inconclusive` with `detail.reason = "no limits for embodiment"`.

## Interfaces
Same `CheckOutcome` as T-017; `checkId` 0x0002 / 0x0003.

## Edge cases
Rate declared 30 but data at 29.97 (video-locked): tolerance covers it;
episodes with `action` absent → kinematics checks state only.

## Tests
Each fixture produces the expected result and `detail` points at the
right frame/joint.

## Acceptance
Both checks run in the T-020 pipeline; unit tests green.

## Security
None beyond I-1 wording.
