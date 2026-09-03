/**
 * T-018 — shared verification-check types.
 *
 * `CheckOutcome` is defined here per this task's supervisor adjustment:
 * T-020 (claim issuance) does not exist yet, so `timing.v1` and
 * `kinematics.v1` are implemented as pure functions over frames returning
 * this shape. T-020 will wire `issueClaim` around it; this is the exact
 * shape PLAN §9.3 / TASK-020.md's `Interfaces` block specify, so no
 * downstream migration is needed when T-020 lands.
 *
 * PLAN §5 I-15: "Thresholds and versions of every check are recorded in
 * the claim `detail`; a claim without them is invalid." — `detail` here
 * always carries `check_version` and `thresholds` for that reason.
 */
import type { JsonObject } from "../../../packages/protocol/src/canonical.ts";

export type CheckResult = "pass" | "fail" | "inconclusive";

export type CheckOutcome = {
  result: CheckResult;
  level: number;
  detail: JsonObject & { check_version: string; thresholds: JsonObject };
};
