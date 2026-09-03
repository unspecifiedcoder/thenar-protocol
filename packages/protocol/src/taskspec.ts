import { type Hex } from "viem";
import { canonicalJson, hashObject, type JsonValue } from "./canonical";

/**
 * A task is a distribution over scenes, not a scene.
 *
 * LIBERO fixes a layout and varies one axis at a time; RoboCasa varies scene,
 * object instance and initial pose within a single task, and RoboCasa data
 * generalises better. So a curator authors ranges and the platform samples them
 * per episode. A curator who publishes one fixed arrangement has published a
 * demo, not a dataset — `validateTaskSpec` says so out loud.
 */

export type Range = [number, number];

export type ObjectSpec = {
  /** Category the instances are drawn from, e.g. "mug". */
  category: string;
  /** Concrete assets sampled per episode. One instance is a fixed prop. */
  instances: string[];
  /** Metres, in the world frame. */
  x: Range;
  y: Range;
  z?: Range;
  /** Radians. */
  yaw?: Range;
  /** How many of this object to place. Omit for exactly one. */
  count?: Range;
};

export type SuccessSpec = {
  /** Predicate over the small physical vocabulary. See PREDICATES. */
  predicate: string;
  toleranceMm: number;
  /** Seconds the goal state must hold before the episode is scored. */
  settleS: number;
};

export type AcceptanceSpec = {
  /** Basis points. An episode below this is not paid and does not enter the corpus. */
  minScoreBps: number;
  maxDurationS: number;
  /** How many accepted episodes the curator considers a complete corpus. */
  targetEpisodes: number;
};

export type TaskSpec = {
  version: 1;
  /** Registry id, e.g. "unitree_g1" — see EMBODIMENTS. */
  embodiment: string;
  /** What the contributor actually drives. */
  actionSpace: ActionSpace;
  instruction: string;
  world: {
    base: string;
    objects: ObjectSpec[];
    lightingIntensity?: Range;
    lightingTemperatureK?: Range;
  };
  success: SuccessSpec;
  acceptance: AcceptanceSpec;
};

/**
 * A humanoid has 23–43 actuated joints and nobody produces trainable data by
 * driving that with a mouse. High-DoF embodiments must reduce the action space
 * and let a controller solve the rest; `validateTaskSpec` enforces it.
 */
export const ACTION_SPACES = [
  "ee_pose_gripper",   // 6-DoF end-effector pose + gripper. The safe default.
  "joint_position",    // direct joint targets. Only sane for low-DoF arms.
  "base_velocity",     // locomotion.
  "whole_body_retarget", // requires a real input device, not a cursor.
] as const;
export type ActionSpace = (typeof ACTION_SPACES)[number];

/** The vocabulary a success predicate may use. Deliberately small: a predicate
 *  that cannot be machine-checked needs a human on every episode, and then the
 *  economics of acceptance collapse. */
export const PREDICATES = [
  "on", "in", "upright_on", "within", "grasped", "released", "settled", "near",
] as const;

export type ValidationIssue = { severity: "error" | "warning"; message: string };

const isRange = (r: unknown): r is Range =>
  Array.isArray(r) && r.length === 2 && r.every((n) => typeof n === "number" && Number.isFinite(n));

const spread = (r?: Range) => (r ? Math.abs(r[1] - r[0]) : 0);

export function validateTaskSpec(spec: TaskSpec): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const err = (m: string) => out.push({ severity: "error", message: m });
  const warn = (m: string) => out.push({ severity: "warning", message: m });

  if (spec.version !== 1) err(`unsupported version ${spec.version}`);
  if (!spec.embodiment) err("embodiment is required");
  if (!ACTION_SPACES.includes(spec.actionSpace)) {
    err(`actionSpace must be one of ${ACTION_SPACES.join(", ")}`);
  }
  if (!spec.instruction || spec.instruction.trim().length < 8) {
    err("instruction must be a sentence a contributor can act on");
  }
  if (!spec.world?.base) err("world.base is required");
  if (!Array.isArray(spec.world?.objects) || spec.world.objects.length === 0) {
    err("a task needs at least one object");
  }

  let varies = spread(spec.world?.lightingIntensity) > 0
    || spread(spec.world?.lightingTemperatureK) > 0;

  for (const [i, o] of (spec.world?.objects ?? []).entries()) {
    const at = `world.objects[${i}]`;
    if (!o.category) err(`${at}.category is required`);
    if (!Array.isArray(o.instances) || o.instances.length === 0) {
      err(`${at}.instances must list at least one asset`);
    }
    for (const k of ["x", "y"] as const) {
      if (!isRange(o[k])) err(`${at}.${k} must be a [min, max] range`);
      else if (o[k][0] > o[k][1]) err(`${at}.${k} has min above max`);
    }
    for (const k of ["z", "yaw"] as const) {
      if (o[k] !== undefined && !isRange(o[k])) err(`${at}.${k} must be a [min, max] range`);
    }
    if (o.count && (!isRange(o.count) || o.count[0] < 0 || o.count[0] > o.count[1])) {
      err(`${at}.count must be a non-negative [min, max] range`);
    }
    if ((o.instances?.length ?? 0) > 1) varies = true;
    if (spread(o.x) > 0 || spread(o.y) > 0 || spread(o.yaw) > 0 || spread(o.count) > 0) varies = true;
  }

  // The whole point of the format.
  if (!varies) {
    err(
      "this task has no variation: every episode would record the same scene. " +
      "Widen a pose range, add object instances, or vary lighting — a fixed " +
      "arrangement is a demo, not a dataset.",
    );
  }

  const p = spec.success?.predicate ?? "";
  if (!p.trim()) err("success.predicate is required");
  else {
    const used = [...p.matchAll(/([a-z_]+)\s*\(/g)].map((m) => m[1]);
    for (const fn of used) {
      if (!PREDICATES.includes(fn as (typeof PREDICATES)[number])) {
        err(`success.predicate uses "${fn}", which is not machine-checkable. ` +
            `Allowed: ${PREDICATES.join(", ")}`);
      }
    }
    if (used.length === 0) err("success.predicate must call at least one predicate");
  }
  if (!(spec.success?.toleranceMm > 0)) err("success.toleranceMm must be positive");
  if (!(spec.success?.settleS >= 0)) err("success.settleS must be zero or more");

  const a = spec.acceptance;
  if (!(a?.minScoreBps >= 0 && a.minScoreBps <= 10000)) err("acceptance.minScoreBps must be 0–10000");
  if (!(a?.maxDurationS > 0)) err("acceptance.maxDurationS must be positive");
  if (!(a?.targetEpisodes > 0)) err("acceptance.targetEpisodes must be positive");
  if (a?.targetEpisodes < 50) {
    warn(`targetEpisodes ${a.targetEpisodes} is below the 50-per-task the ` +
         `benchmark literature uses; a buyer will read that as a pilot`);
  }

  // High-DoF embodiments cannot be driven joint-by-joint from a browser.
  if (spec.actionSpace === "joint_position" && HIGH_DOF.has(spec.embodiment)) {
    err(`${spec.embodiment} is high-DoF: joint_position cannot be driven from a ` +
        `cursor. Use ee_pose_gripper, or whole_body_retarget with a real device.`);
  }
  return out;
}

const HIGH_DOF = new Set([
  "unitree_g1", "unitree_h1", "apptronik_apollo", "booster_t1", "fourier_n1",
  "pal_talos", "berkeley_humanoid", "robotis_op3", "pnd_adam_lite",
  "toddlerbot_2xc", "toddlerbot_2xm", "shadow_hand", "shadow_dex_ee", "allegro_hand",
]);

/**
 * @deprecated Use `canonicalJson` from `./canonical` (RFC 8785 / JCS). Kept
 * as a thin alias — not reimplemented — so existing `taskId` vectors stay
 * byte-identical: this used to be a bespoke sorted-keys serialiser that
 * happened to be JCS-compatible for the value types `TaskSpec` uses, but it
 * was never named or tested as JCS (T-001).
 */
export function canonicalise(value: unknown): string {
  return canonicalJson(value as JsonValue);
}

export function taskId(spec: TaskSpec): Hex {
  return hashObject(spec as unknown as JsonValue);
}
