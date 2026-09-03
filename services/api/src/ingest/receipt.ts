/**
 * T-036 — AppendReceipt v1 (PLAN §9.5, §10.6). Signed by the log service's
 * own key ("the operator key", distinct from any org's or verifier's key —
 * see Security note in TASKS/TASK-036.md) over
 * `message("append-receipt", hashObjectExcluding(r, ["signature"]))`.
 */
import type { Hex } from "viem";
import { hashObjectExcluding, type JsonObject } from "../../../../packages/protocol/src/canonical.ts";
import { sign as signObject } from "../../../../packages/protocol/src/sign.ts";

export type AppendReceipt = {
  v: 1;
  kind: "append_receipt";
  leaf_hash: Hex;
  leaf_index: number;
  log_size_after: number;
  received_at: number;
  signature: { alg: "ed25519"; key_id: Hex; sig: Hex };
};

export type OperatorSigner = { keyId: Hex; privateKey: Hex };

/** Builds and signs one AppendReceipt (PLAN §9.5) for a just-appended leaf. */
export async function signAppendReceipt(
  signer: OperatorSigner,
  leafHash: Hex,
  leafIndex: number,
  logSizeAfter: number,
  receivedAt: number,
): Promise<AppendReceipt> {
  const unsigned = {
    v: 1 as const,
    kind: "append_receipt" as const,
    leaf_hash: leafHash,
    leaf_index: leafIndex,
    log_size_after: logSizeAfter,
    received_at: receivedAt,
  };
  const objectHash = hashObjectExcluding(unsigned as unknown as JsonObject, ["signature"]);
  const sig = await signObject("ed25519", "appendReceipt", objectHash, signer.privateKey);
  return { ...unsigned, signature: { alg: "ed25519", key_id: signer.keyId, sig } };
}
