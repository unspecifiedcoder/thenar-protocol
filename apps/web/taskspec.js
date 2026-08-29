/* taskspec.js — the TaskSpec rules, in the browser.
 *
 * A mirror of packages/protocol/src/taskspec.ts. The builder has to validate
 * and hash exactly as the exporter and the registry do, or a curator publishes
 * an id nobody else computes. `taskspec.test.mjs` holds the two to each other
 * on both the canonical hash and every validation message.
 */
import { keccak256 } from "./keccak.js";

export const ACTION_SPACES = [
  "ee_pose_gripper", "joint_position", "base_velocity", "whole_body_retarget",
];

export const PREDICATES = [
  "on", "in", "upright_on", "within", "grasped", "released", "settled", "near",
];

const HIGH_DOF = new Set([
  "unitree_g1", "unitree_h1", "apptronik_apollo", "booster_t1", "fourier_n1",
  "pal_talos", "berkeley_humanoid", "robotis_op3", "pnd_adam_lite",
  "toddlerbot_2xc", "toddlerbot_2xm", "shadow_hand", "shadow_dex_ee", "allegro_hand",
]);

const isRange = (r) =>
  Array.isArray(r) && r.length === 2 && r.every((n) => typeof n === "number" && Number.isFinite(n));
const spread = (r) => (r ? Math.abs(r[1] - r[0]) : 0);

export function validateTaskSpec(spec) {
  const out = [];
  const err = (m) => out.push({ severity: "error", message: m });
  const warn = (m) => out.push({ severity: "warning", message: m });

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
    for (const k of ["x", "y"]) {
      if (!isRange(o[k])) err(`${at}.${k} must be a [min, max] range`);
      else if (o[k][0] > o[k][1]) err(`${at}.${k} has min above max`);
    }
    for (const k of ["z", "yaw"]) {
      if (o[k] !== undefined && !isRange(o[k])) err(`${at}.${k} must be a [min, max] range`);
    }
    if (o.count && (!isRange(o.count) || o.count[0] < 0 || o.count[0] > o.count[1])) {
      err(`${at}.count must be a non-negative [min, max] range`);
    }
    if ((o.instances?.length ?? 0) > 1) varies = true;
    if (spread(o.x) > 0 || spread(o.y) > 0 || spread(o.yaw) > 0 || spread(o.count) > 0) varies = true;
  }

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
      if (!PREDICATES.includes(fn)) {
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

  if (spec.actionSpace === "joint_position" && HIGH_DOF.has(spec.embodiment)) {
    err(`${spec.embodiment} is high-DoF: joint_position cannot be driven from a ` +
        `cursor. Use ee_pose_gripper, or whole_body_retarget with a real device.`);
  }
  return out;
}

/** Keys sorted at every level, no whitespace — the id must not depend on order. */
export function canonicalise(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalise).join(",")}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalise(value[k])}`).join(",")}}`;
}

export function taskId(spec) {
  const bytes = new TextEncoder().encode(canonicalise(spec));
  return keccak256("0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""));
}
