/**
 * T-036 — the log service's own signing key ("the operator key", PLAN
 * §9.5/§10.6). It signs every `AppendReceipt`; it is deliberately a
 * different key from any org's or any verifier's (Security note,
 * TASK-036.md: "the operator key is distinct from the verifier key").
 */
import { randomBytes } from "node:crypto";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { toBytes, toHex, type Hex } from "viem";
import type { ILogStore } from "../../../log/src/store-interface.ts";
import type { Registry } from "../registry.ts";
import { keyId as deriveKeyId } from "../../../../packages/protocol/src/sign.ts";
import type { OperatorSigner } from "./receipt.ts";

ed.hashes.sha512 = sha512;

/** A fixed, well-known org id the operator key is registered under (T-024 `org` table). */
export const OPERATOR_ORG_ID = "org_operator";

/**
 * `env.OPERATOR_KEY` (a `0x` + 64 lowercase hex ed25519 seed) if set;
 * otherwise a freshly generated one for local/dev use, so the app still
 * boots (and every receipt still verifies internally) without a checked-in
 * secret. Not used for anything but signing THENAR's own receipts, so an
 * ephemeral dev key here is not a security-sensitive shortcut the way an
 * invented data value would be.
 */
export function loadOperatorSigner(envKey: string | undefined): OperatorSigner | null {
  const privateKey = (envKey && /^0x[0-9a-f]{64}$/i.test(envKey) ? (envKey.toLowerCase() as Hex) : toHex(randomBytes(32)));
  const pubkey = toHex(ed.getPublicKey(toBytes(privateKey)));
  const keyId = deriveKeyId(pubkey);
  return { keyId, privateKey };
}

/**
 * Registers `operator`'s pubkey as a `SigningKey` of `OPERATOR_ORG_ID` on
 * boot, if it is not registered already — so `Registry.resolveKey` (D-20)
 * and any verifier of a receipt have a published key to check against.
 * Idempotent: a second boot against the same database is a no-op.
 */
export function ensureOperatorKey(store: ILogStore, registry: Registry, operator: OperatorSigner): void {
  if (store.signingKey(operator.keyId)) return;
  if (!store.org(OPERATOR_ORG_ID)) {
    store.createOrg({ orgId: OPERATOR_ORG_ID, name: "THENAR Operator", kind: "verifier", status: "active", createdAt: Math.floor(Date.now() / 1000) });
  }
  const pubkey = toHex(ed.getPublicKey(toBytes(operator.privateKey)));
  registry.registerKey(OPERATOR_ORG_ID, { alg: "ed25519", pubkey });
}
