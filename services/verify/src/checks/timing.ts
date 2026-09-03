/**
 * T-018 — L3 check `timing.v1` (PLAN §10.9 check id 0x0002).
 *
 * Pure rule check: an episode's `timestamp` column must be strictly
 * increasing and consistent with its declared `rate_hz` (TASK-018.md
 * "Rules"). Deterministic; no data-dependent thresholds are configurable
 * here — the tolerances are protocol-level constants (PLAN §10.9 "protocol
 * constant" / "implementation detail" rows), so they are simply recorded in
 * `detail.thresholds` rather than read from `config/checks.json` (that file
 * belongs to T-020, which does not exist yet — see this task's supervisor
 * adjustment note in `src/types.ts`).
 *
 * Rules (TASK-018.md):
 *  - `timestamp` strictly increasing.
 *  - `|Δt − 1/rate_hz| ≤ 0.25/rate_hz` for ≥ 99% of frames.
 *  - no gap (Δt) > 5/rate_hz.
 *  - frame count within ±2 of `duration_ms · rate_hz / 1000`.
 * Any violated -> `fail`, with the first offending frame recorded in
 * `detail`.
 */
import type { CheckOutcome } from "../types.ts";

export const CHECK_VERSION = "timing.v1.0";

export function timingCheck(
  frames: { timestamp: number[] },
  rateHz: number,
  durationMs: number,
): CheckOutcome {
  const ts = frames.timestamp;
  const periodTolerance = rateHz > 0 ? 0.25 / rateHz : Infinity;
  const maxGap = rateHz > 0 ? 5 / rateHz : Infinity;
  const expectedFrames = rateHz > 0 ? (durationMs * rateHz) / 1000 : null;

  const thresholds = {
    period_tolerance_fraction: 0.25,
    min_within_tolerance_fraction: 0.99,
    max_gap_fraction: 5,
    frame_count_tolerance: 2,
  };

  const detailBase = { check_version: CHECK_VERSION, thresholds };

  if (rateHz <= 0) {
    return {
      result: "inconclusive",
      level: 3,
      detail: { ...detailBase, reason: "rate_hz not positive" },
    };
  }

  if (ts.length === 0) {
    return {
      result: "fail",
      level: 3,
      detail: { ...detailBase, reason: "no frames", offending_frame: 0 },
    };
  }

  const expectedPeriod = 1 / rateHz;

  // 1. Strictly increasing.
  for (let i = 1; i < ts.length; i++) {
    if (!(ts[i] > ts[i - 1])) {
      return {
        result: "fail",
        level: 3,
        detail: {
          ...detailBase,
          reason: "timestamp not strictly increasing",
          offending_frame: i,
          timestamp: ts[i],
          previous_timestamp: ts[i - 1],
        },
      };
    }
  }

  // 2. No gap larger than max_gap.
  for (let i = 1; i < ts.length; i++) {
    const dt = ts[i] - ts[i - 1];
    if (dt > maxGap) {
      return {
        result: "fail",
        level: 3,
        detail: {
          ...detailBase,
          reason: "gap exceeds max_gap",
          offending_frame: i,
          delta_t: dt,
          max_gap: maxGap,
        },
      };
    }
  }

  // 3. >= 99% of frames within |dt - 1/rate| <= tolerance.
  let withinTolerance = 0;
  let firstOutOfTolerance: number | null = null;
  const deltaCount = ts.length - 1;
  for (let i = 1; i < ts.length; i++) {
    const dt = ts[i] - ts[i - 1];
    if (Math.abs(dt - expectedPeriod) <= periodTolerance) {
      withinTolerance++;
    } else if (firstOutOfTolerance === null) {
      firstOutOfTolerance = i;
    }
  }
  if (deltaCount > 0) {
    const fraction = withinTolerance / deltaCount;
    if (fraction < thresholds.min_within_tolerance_fraction) {
      return {
        result: "fail",
        level: 3,
        detail: {
          ...detailBase,
          reason: "too many frames outside period tolerance",
          offending_frame: firstOutOfTolerance,
          fraction_within_tolerance: fraction,
        },
      };
    }
  }

  // 4. Frame count within +-2 of duration_ms * rate_hz / 1000.
  if (expectedFrames !== null) {
    if (Math.abs(ts.length - expectedFrames) > thresholds.frame_count_tolerance) {
      return {
        result: "fail",
        level: 3,
        detail: {
          ...detailBase,
          reason: "frame count out of tolerance",
          offending_frame: 0,
          frame_count: ts.length,
          expected_frame_count: expectedFrames,
        },
      };
    }
  }

  return { result: "pass", level: 3, detail: { ...detailBase } };
}
