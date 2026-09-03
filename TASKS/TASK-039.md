# T-039 — `task_compliance.v1` check (port of the live scorer) — DEFERRED, FD-5

**Tier:** STRONG implementation; **FRONTIER gate FD-5** for weights/thresholds.
**Do not start before E2.**

## Objective
Port the live site's scorer — placement (55 %), smoothness (25 %),
time-against-par (20 %) against a task datum — as check id `0x0007
task_compliance.v1`: input = episode frames + a task datum
(`task.task_id` → TaskSpec or a minimal `{ target_pose, tolerance_mm, par_s }`),
output = `CheckOutcome` with `detail.scores` and `thresholds`; `pass` iff
score ≥ `min_score_bps` (config, FD-5); never a payment rule (D-32).

## Dependencies
T-020, T-040; FD-5 open.

## Files
`services/verify/src/checks/task_compliance.ts`, tests, `config/checks.json` entry (`blocking: false, emit_fail: false`), PLAN §10.9 id table (add 0x0007 by ADR when this task starts — file a conflict if not yet added).

## Acceptance
Deterministic scores on scripted trajectories; thresholds recorded (I-15).
