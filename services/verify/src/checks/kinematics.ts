/**
 * T-018 — L3 check `kinematics.v1` (PLAN §10.9 check id 0x0003).
 *
 * Pure rule check: an episode's `observation.state` (and `action`, when
 * present) must be physically plausible for the declared embodiment
 * (TASK-018.md "Rules"):
 *  - every `observation.state[j]` within `jointLimits[j]` (tolerance 1°).
 *  - finite-difference velocity <= `maxVel[j]`.
 *  - acceleration spikes (> 50 rad/s^2) flagged.
 *  - `action` within limits, when the episode carries an `action` column.
 *
 * Embodiments without recorded `jointLimits`/`maxVel` (PLAN §10.9,
 * `packages/protocol/src/embodiments.ts`) — including unknown embodiment
 * ids — can't be checked, so the outcome is `inconclusive` with
 * `detail.reason = "no limits for embodiment"` (TASK-018.md Rules).
 *
 * Velocity and acceleration are estimated by simple finite difference at
 * the declared `rateHz` (TASK-018.md Edge cases: "episodes with `action`
 * absent -> kinematics checks state only"; no per-frame timestamps are
 * taken here, only the declared rate — `timing.v1` is the check that
 * validates the timestamps themselves).
 *
 * A `fail` is emitted for the first rule violated, first offending
 * frame/joint recorded in `detail`, mirroring `timing.v1`'s "Any violated
 * -> fail" rule — the deterministic-rule-check contract this task's Tier
 * (STRONG, "rules fixed here") sets for both checks.
 */
import { byId } from "../../../../packages/protocol/src/embodiments.ts";
import type { CheckOutcome } from "../types.ts";

export const CHECK_VERSION = "kinematics.v1.0";

const DEG_TO_RAD = Math.PI / 180;

type Rules = { jointLimitToleranceRad: number; maxAccel: number };

function checkSeries(
  series: number[][],
  seriesName: "observation.state" | "action",
  jointLimits: [number, number][],
  maxVel: number[],
  dt: number,
  rules: Rules,
): { violation: Record<string, unknown> } | null {
  const dof = jointLimits.length;

  // Range check (tolerance 1 degree, TASK-018.md).
  for (let i = 0; i < series.length; i++) {
    const frame = series[i];
    for (let j = 0; j < dof; j++) {
      const v = frame[j];
      const [lo, hi] = jointLimits[j];
      if (v < lo - rules.jointLimitToleranceRad || v > hi + rules.jointLimitToleranceRad) {
        return {
          violation: {
            reason: `${seriesName} joint out of range`,
            offending_frame: i,
            offending_joint: j,
            value: v,
            limit: [lo, hi],
          },
        };
      }
    }
  }

  // Finite-difference velocity <= maxVel[j].
  const velocities: number[][] = [];
  for (let i = 1; i < series.length; i++) {
    const vel: number[] = [];
    for (let j = 0; j < dof; j++) {
      vel.push((series[i][j] - series[i - 1][j]) / dt);
    }
    velocities.push(vel);
    for (let j = 0; j < dof; j++) {
      if (Math.abs(vel[j]) > maxVel[j]) {
        return {
          violation: {
            reason: `${seriesName} velocity exceeds maxVel`,
            offending_frame: i,
            offending_joint: j,
            velocity: vel[j],
            max_vel: maxVel[j],
          },
        };
      }
    }
  }

  // Acceleration spikes (> 50 rad/s^2), finite difference of velocity.
  for (let i = 1; i < velocities.length; i++) {
    for (let j = 0; j < dof; j++) {
      const accel = (velocities[i][j] - velocities[i - 1][j]) / dt;
      if (Math.abs(accel) > rules.maxAccel) {
        return {
          violation: {
            reason: `${seriesName} acceleration spike`,
            // `i` indexes `velocities`, which starts at frame 1 of `series`;
            // the offending frame in `series` is therefore `i + 1`.
            offending_frame: i + 1,
            offending_joint: j,
            acceleration: accel,
            max_accel: rules.maxAccel,
          },
        };
      }
    }
  }

  return null;
}

export function kinematicsCheck(
  frames: { state: number[][]; action?: number[][] },
  embodimentId: string,
  rateHz: number,
): CheckOutcome {
  const rules: Rules = { jointLimitToleranceRad: 1 * DEG_TO_RAD, maxAccel: 50 };
  const thresholds = {
    joint_limit_tolerance_deg: 1,
    max_accel_rad_s2: rules.maxAccel,
  };
  const detailBase = { check_version: CHECK_VERSION, thresholds };

  const embodiment = byId(embodimentId);
  if (!embodiment || !embodiment.jointLimits || !embodiment.maxVel) {
    return {
      result: "inconclusive",
      level: 3,
      detail: { ...detailBase, reason: "no limits for embodiment", embodiment_id: embodimentId },
    };
  }

  const { jointLimits, maxVel } = embodiment;

  if (rateHz <= 0) {
    return {
      result: "inconclusive",
      level: 3,
      detail: { ...detailBase, reason: "rate_hz not positive" },
    };
  }
  const dt = 1 / rateHz;

  if (frames.state.length === 0) {
    return {
      result: "fail",
      level: 3,
      detail: { ...detailBase, reason: "no frames", offending_frame: 0 },
    };
  }

  const dof = jointLimits.length;
  if (frames.state[0].length !== dof) {
    return {
      result: "inconclusive",
      level: 3,
      detail: {
        ...detailBase,
        reason: "joint count mismatch",
        embodiment_id: embodimentId,
        state_dof: frames.state[0].length,
        embodiment_dof: dof,
      },
    };
  }

  const stateViolation = checkSeries(frames.state, "observation.state", jointLimits, maxVel, dt, rules);
  if (stateViolation) {
    return { result: "fail", level: 3, detail: { ...detailBase, ...stateViolation.violation } };
  }

  if (frames.action && frames.action.length > 0) {
    const actionViolation = checkSeries(frames.action, "action", jointLimits, maxVel, dt, rules);
    if (actionViolation) {
      return { result: "fail", level: 3, detail: { ...detailBase, ...actionViolation.violation } };
    }
  }

  return { result: "pass", level: 3, detail: { ...detailBase } };
}
