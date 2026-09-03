/**
 * T-020 — THENAR's own verifier key ("the verifier key", PLAN §9.3/§10.6).
 * It signs every VerificationClaim the worker issues for THENAR's own
 * checks (`services/verify/src/worker.ts`); deliberately a different key
 * from the operator's (Security note, TASK-020.md: "Verifier key in
 * env/KMS only"; TASK-036.md: "the operator key is distinct from the
 * verifier key") and registered under its own organisation
 * (`org_verifier`, a sibling of `org_operator`, kind `verifier`) so
 * `Registry.resolveKey` (D-20/I-14) and `POST /claims`'s role check both
 * have a real row to check against.
 */
import { randomBytes } from "node:crypto";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { toBytes, toHex, type Hex } from "viem";
import type { ILogStore } from "../../../log/src/store-interface.ts";
import type { Registry } from "../registry.ts";
import { keyId as deriveKeyId } from "../../../../packages/protocol/src/sign.ts";
import type { VerifierSigner } from "../../../verify/src/issue.ts";

ed.hashes.sha512 = sha512;

/** A fixed, well-known org id the verifier key is registered under (T-024 `org` table) — the sibling of `OPERATOR_ORG_ID`. */
export const VERIFIER_ORG_ID = "org_verifier";

/**
 * `env.VERIFIER_KEY` (a `0x` + 64 lowercase hex ed25519 seed) if set;
 * otherwise a freshly generated one for local/dev use, mirroring
 * `loadOperatorSigner` — an ephemeral dev key here is not a
 * security-sensitive shortcut the way an invented data value would be.
 */
export function loadVerifierSigner(envKey: string | undefined): VerifierSigner {
  const privateKey = (envKey && /^0x[0-9a-f]{64}$/i.test(envKey) ? (envKey.toLowerCase() as Hex) : toHex(randomBytes(32)));
  const pubkey = toHex(ed.getPublicKey(toBytes(privateKey)));
  const keyId = deriveKeyId(pubkey);
  return { keyId, privateKey };
}

/**
 * Registers `verifier`'s pubkey as a `SigningKey` of `VERIFIER_ORG_ID` on
 * boot, if it is not registered already — mirrors `ensureOperatorKey`.
 * Idempotent: a second boot against the same database is a no-op.
 */
export function ensureVerifierKey(store: ILogStore, registry: Registry, verifier: VerifierSigner): void {
  if (store.signingKey(verifier.keyId)) return;
  if (!store.org(VERIFIER_ORG_ID)) {
    store.createOrg({ orgId: VERIFIER_ORG_ID, name: "THENAR Verifier", kind: "verifier", status: "active", createdAt: Math.floor(Date.now() / 1000) });
  }
  const pubkey = toHex(ed.getPublicKey(toBytes(verifier.privateKey)));
  registry.registerKey(VERIFIER_ORG_ID, { alg: "ed25519", pubkey });
}
