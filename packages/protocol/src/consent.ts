import { keccak256, concatHex, toHex, type Hex } from "viem";
import { hashObject, type JsonValue } from "./canonical";
import { commitConsent } from "./leaf";

/**
 * ConsentRecord v1 — one per episode (PLAN Sec9.4, D-19).
 *
 * A fresh 16-byte nonce is drawn per episode so that `recordHash` (and thus
 * `consentKey`, Sec27 trap #8) differs across episodes even when the same
 * holder key signs every one of them — unlinkability (Sec5 I-6) depends on
 * this.
 */
export type ConsentRecord = {
  v: 1;
  kind: "consent_record";
  holder: "contributor" | "organisation";
  pubkey: Hex;
  alg: "ed25519" | "p256";
  scope_bits: number;
  terms_hash: Hex;
  granted_at: number;
  nonce: Hex;
};

const NONCE_BYTES = 16;

function hexByteLength(hex: Hex): number {
  return (hex.length - 2) / 2;
}

function freshNonce(): Hex {
  const bytes = new Uint8Array(NONCE_BYTES);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/** Builds a fresh `ConsentRecord`, drawing a new 16-byte nonce for this episode. */
export function newConsentRecord(
  input: Omit<ConsentRecord, "v" | "kind" | "nonce">,
): ConsentRecord {
  return { v: 1, kind: "consent_record", ...input, nonce: freshNonce() };
}

/**
 * `hashObject(record)` (PLAN Sec9.4). Rejects a nonce that is not exactly
 * 16 bytes rather than silently hashing whatever length was handed in —
 * a short or padded nonce would weaken the unlinkability the nonce exists
 * to provide.
 */
export function recordHash(r: ConsentRecord): Hex {
  if (hexByteLength(r.nonce) !== NONCE_BYTES) {
    throw new Error(`consent record nonce must be ${NONCE_BYTES} bytes, got ${hexByteLength(r.nonce)}`);
  }
  return hashObject(r as unknown as JsonValue);
}

const CONSENT_KEY_PREFIX = "0x02" as Hex;

/** `keccak256(0x02 ‖ recordHash)` — the sparse-tree key for this episode's consent (PLAN Sec9.4). */
export function consentKey(hash: Hex): Hex {
  return keccak256(concatHex([CONSENT_KEY_PREFIX, hash]));
}

/**
 * `keccak256(recordHash ‖ salt)` (PLAN Sec10.5), `salt` = 32 fresh random
 * bytes per episode. Identical to `commitConsent` in `leaf.ts`; re-exported
 * under the name this task's interface names so both call sites agree there
 * is exactly one commitment formula.
 */
export function consentCommitment(hash: Hex, salt32: Hex): Hex {
  return commitConsent(hash, salt32);
}

/** `keccak256(recordHash ‖ utf8("revoked"))` — the sparse-tree revocation value (PLAN Sec10.2). */
export function revocationValue(hash: Hex): Hex {
  return keccak256(concatHex([hash, toHex("revoked")]));
}
