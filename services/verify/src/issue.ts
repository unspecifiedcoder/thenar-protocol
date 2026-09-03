/**
 * T-020 — claim issuance: builds, signs, encodes and appends one
 * VerificationClaim leaf (0x04, PLAN §10.3) per check result.
 *
 * Two entry points:
 *  - `issueClaim` — THENAR's own checks (worker.ts): builds an unsigned
 *    VerificationClaim from a `CheckOutcome`, applies `config/checks.json`'s
 *    `emit_fail` downgrade (a `fail` becomes `inconclusive` with
 *    `detail.downgraded_from: "fail"` when the check isn't allowed to
 *    block yet — PLAN §10.9, `TASKS/CONFLICTS.md` FD-1/FD-2), signs it with
 *    the verifier key, and appends.
 *  - `appendClaim` — an already-signed VerificationClaim (the `POST
 *    /claims` external-verifier path, `services/api/src/routes/claims.ts`):
 *    no downgrade ("external verifiers own their config" — TASK-020.md
 *    binding rules) but I-15 (thresholds/check_version present) still
 *    applies, and the same idempotency/append logic runs.
 *
 * I-15 ("Thresholds and versions of every check are recorded in the claim
 * `detail`; a claim without them is invalid") is enforced before anything
 * is written, in both paths, by `assertDetail`.
 *
 * Idempotency (TASK-020.md "Expected behaviour"): per `(subjectLeaf,
 * check, verifierKeyId, result, detailHash)` — a repeat of the exact same
 * outcome returns the existing leaf rather than appending (and rejecting)
 * a duplicate; a changed outcome (different result or detail) issues a new
 * claim, since the log is append-only (I-2).
 */
import { keccak256, type Hex } from "viem";
import { hashObject, hashObjectExcluding, type JsonObject } from "../../../packages/protocol/src/canonical.ts";
import { encodeClaim, claimLeafHash } from "../../../packages/protocol/src/claim.ts";
import { sign as signObject } from "../../../packages/protocol/src/sign.ts";
import type { VerificationClaim } from "../../../packages/protocol/src/schemas.ts";
import type { ILogStore } from "../../log/src/store-interface.ts";
import { getCheckConfig, type CheckConfig } from "./config.ts";
import type { CheckOutcome, CheckResult } from "./types.ts";

/** PLAN §10.9 — check ids (0x0001..0x0007, append-only). */
export const CHECK_IDS: Record<string, number> = {
  "dedup.v1": 1,
  "timing.v1": 2,
  "kinematics.v1": 3,
  "sensor_consistency.v1": 4,
  "sim_signature.v1": 5,
  "attestation.v1": 6,
  "task_compliance.v1": 7,
};

/** PLAN §10.3 0x04 leaf `result` byte: 0 fail, 1 pass, 2 inconclusive. */
const RESULT_CODES: Record<CheckResult, 0 | 1 | 2> = { fail: 0, pass: 1, inconclusive: 2 };

export type VerifierSigner = { keyId: Hex; privateKey: Hex };

/** Thrown by `assertDetail` — the caller never writes anything (I-15). */
export class MissingThresholdsError extends Error {}

/** Thrown when `check` isn't in `CHECK_IDS` (unrecognised leaf `checkId`) — `services/api/src/routes/claims.ts` maps this to 422. */
export class UnknownCheckError extends Error {}

/** I-15: refuse a claim whose `detail` lacks `check_version` or `thresholds`. */
function assertDetail(detail: unknown): asserts detail is JsonObject & { check_version: string; thresholds: JsonObject } {
  const d = detail as Record<string, unknown> | null | undefined;
  if (!d || typeof d !== "object" || Array.isArray(d)) {
    throw new MissingThresholdsError("claim detail must be an object (I-15)");
  }
  if (typeof d.check_version !== "string" || d.check_version.length === 0) {
    throw new MissingThresholdsError("claim detail missing check_version (I-15)");
  }
  if (typeof d.thresholds !== "object" || d.thresholds === null || Array.isArray(d.thresholds)) {
    throw new MissingThresholdsError("claim detail missing thresholds (I-15)");
  }
}

export type IssueOutcome = { claim: VerificationClaim; leafHash: Hex; leafIndex: number };

/**
 * Encodes + appends a fully-formed (signed) `VerificationClaim`. Shared by
 * `issueClaim` and the external-verifier `POST /claims` path.
 *
 * Idempotent per `(subjectLeaf, check, verifierKeyId, result, detailHash)`
 * — a matching prior claim already in `store.claimsFor(subjectLeaf)` is
 * returned as-is rather than appended again.
 */
export async function appendClaim(store: ILogStore, claim: VerificationClaim): Promise<IssueOutcome> {
  assertDetail(claim.detail);
  const detailHash = hashObject(claim.detail as JsonObject);

  const existing = store
    .claimsFor(claim.subject_leaf as Hex)
    .find(
      (c) =>
        c.check === claim.check &&
        c.verifierKeyId === claim.verifier_key_id &&
        c.result === claim.result &&
        c.detailHash === detailHash,
    );
  if (existing) {
    const leafIndex = store.indexOfLeaf(existing.leafHash);
    if (leafIndex !== null) return { claim, leafHash: existing.leafHash, leafIndex };
  }

  const checkId = CHECK_IDS[claim.check];
  if (!checkId) throw new UnknownCheckError(`unknown check "${claim.check}"`);

  const signatureHash = keccak256(claim.signature.sig as Hex);
  const preimage = encodeClaim({
    subjectLeaf: claim.subject_leaf as Hex,
    verifierKeyId: claim.verifier_key_id as Hex,
    detailHash,
    signatureHash,
    checkId,
    result: RESULT_CODES[claim.result],
    levelAsserted: claim.level_asserted,
    issuedAt: BigInt(claim.issued_at),
  });
  const leafHash = claimLeafHash(preimage);
  const leafIndex = store.append(leafHash, { preimage });
  store.recordClaim({
    leafHash,
    subjectLeaf: claim.subject_leaf as Hex,
    verifierKeyId: claim.verifier_key_id as Hex,
    check: claim.check,
    result: claim.result,
    levelAsserted: claim.level_asserted,
    detail: JSON.stringify(claim.detail),
    detailHash,
    issuedAt: claim.issued_at,
    signature: JSON.stringify(claim.signature),
  });
  return { claim, leafHash, leafIndex };
}

/**
 * THENAR's own checks: builds, signs and appends a VerificationClaim for
 * `check`'s `outcome`. Applies `config/checks.json`'s `emit_fail`
 * downgrade — TASK-020.md "Expected behaviour": a `fail` outcome on a
 * check configured `emit_fail: false` becomes `inconclusive` with
 * `detail.downgraded_from: "fail"`.
 */
export async function issueClaim(
  subjectLeaf: Hex,
  check: string,
  outcome: CheckOutcome,
  verifierKey: VerifierSigner,
  store: ILogStore,
  opts: { now?: () => number; levelAsserted?: number; config?: CheckConfig } = {},
): Promise<IssueOutcome> {
  assertDetail(outcome.detail);

  const config = opts.config ?? getCheckConfig(check);
  let result: CheckResult = outcome.result;
  let detail: JsonObject = { ...outcome.detail };
  if (result === "fail" && !config.emit_fail) {
    result = "inconclusive";
    detail = { ...detail, downgraded_from: "fail" };
  }

  const now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  const unsigned = {
    v: 1 as const,
    kind: "verification_claim" as const,
    subject_leaf: subjectLeaf,
    verifier_key_id: verifierKey.keyId,
    check,
    result,
    level_asserted: opts.levelAsserted ?? outcome.level,
    detail,
    issued_at: now(),
  };
  const objectHash = hashObjectExcluding(unsigned as unknown as JsonObject, ["signature"]);
  const sig = await signObject("ed25519", "claim", objectHash, verifierKey.privateKey);
  const claim = {
    ...unsigned,
    signature: { alg: "ed25519" as const, key_id: verifierKey.keyId, sig },
  } as unknown as VerificationClaim;

  return appendClaim(store, claim);
}
