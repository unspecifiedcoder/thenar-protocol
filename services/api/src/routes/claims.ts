import { Hono } from "hono";
import type { Hex } from "viem";
import type { AppEnv } from "../app.ts";
import { getJsonBody, parseOrThrow } from "../app.ts";
import { requireAuth, requireRole } from "../auth.ts";
import { ApiError } from "../errors.ts";
import { VerificationClaim } from "../schemas/verificationClaim.ts";
import { verify as verifySignature } from "../../../../packages/protocol/src/sign.ts";
import { hashObjectExcluding, type JsonObject } from "../../../../packages/protocol/src/canonical.ts";
import { appendClaim, UnknownCheckError, MissingThresholdsError } from "../../../verify/src/issue.ts";
import { getCheckConfig } from "../../../verify/src/config.ts";

export const claimRoutes = new Hono<AppEnv>()
  // POST /v1/claims — external verifier. PLAN §12 binding rule
  // (TASK-020.md): the caller's API key must carry role `verifier` *and*
  // the claim's own `verifier_key_id` must resolve (D-20/I-14, T-024) to a
  // currently-valid signing key of an org registered `kind: "verifier"`,
  // whose signature over the claim actually verifies (I-13: "unsigned or
  // unregistered claims are refused"). An unrecognised `check` (not in
  // `config/checks.json`) is `unprocessable` (422) — the schema's `check`
  // enum still admits `attestation.v1`/Phase-D names PLAN §9.3 lists, but
  // this deployment hasn't configured them yet. No `emit_fail` downgrade
  // here (TASK-020.md: "external verifiers own their config") — I-15
  // (thresholds/check_version present) still applies via `appendClaim`.
  .post("/claims", async (c) => {
    const { keyStore, registry, logStore } = c.get("deps");

    const principal = requireAuth(keyStore, c.req.header("Authorization"));
    requireRole(principal, "verifier");

    const body = parseOrThrow(VerificationClaim, await getJsonBody(c));

    if (!logStore) throw new ApiError("internal", "log store not configured");

    // Unknown check -> 422 before any key/signature work (cheap check first).
    try {
      getCheckConfig(body.check);
    } catch {
      throw new ApiError("unprocessable", `unknown check "${body.check}"`, { check: body.check });
    }

    // D-20/I-14: validity evaluated at "now" for a not-yet-anchored leaf,
    // re-evaluated at anchor time by T-021.
    const now = Math.floor(Date.now() / 1000);
    const keyRow = registry.resolveKey(body.verifier_key_id as Hex, now);
    if (!keyRow) {
      throw new ApiError("unauthorized", "verifier_key_id is not a currently-valid signing key");
    }
    const keyOrg = logStore.org(keyRow.orgId);
    if (!keyOrg || keyOrg.kind !== "verifier") {
      throw new ApiError("forbidden", "verifier_key_id does not belong to a verifier organisation");
    }

    const objectHash = hashObjectExcluding(body as unknown as JsonObject, ["signature"]);
    const sigValid = await verifySignature(
      body.signature.alg as "ed25519" | "p256",
      "claim",
      objectHash,
      body.signature.sig as Hex,
      keyRow.pubkey,
    );
    if (!sigValid) {
      throw new ApiError("unauthorized", "claim signature does not verify");
    }

    try {
      const { leafHash, leafIndex } = await appendClaim(logStore, body as any);
      return c.json({ leaf_hash: leafHash, leaf_index: leafIndex });
    } catch (err) {
      if (err instanceof UnknownCheckError) {
        throw new ApiError("unprocessable", err.message, { check: body.check });
      }
      if (err instanceof MissingThresholdsError) {
        throw new ApiError("unprocessable", err.message);
      }
      throw err;
    }
  });
