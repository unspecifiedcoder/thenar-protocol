import { keccak256, toBytes, toHex, type Hex } from "viem";
import * as ed from "@noble/ed25519";
import { p256 } from "@noble/curves/nist.js";
import { sha512 } from "@noble/hashes/sha2.js";

/**
 * The four THENAR signature domains (PLAN Sec10.6) and the two algorithms
 * consent holders may sign with: Ed25519 (software keys) and P-256
 * (hardware keys), per D-6/D-26.
 *
 * `@noble/ed25519`'s synchronous API needs a SHA-512 implementation wired
 * in before first use — done once here, at module load, rather than at
 * every call site.
 */
ed.hashes.sha512 = sha512;

export const DOMAINS = {
  manifest: "THENAR/v1/manifest",
  revoke: "THENAR/v1/revoke",
  claim: "THENAR/v1/claim",
  appendReceipt: "THENAR/v1/append-receipt",
} as const;

export type Domain = keyof typeof DOMAINS;
export type Alg = "ed25519" | "p256";

const ZERO_BYTE = new Uint8Array([0]);

/** `utf8(domain) ‖ 0x00 ‖ objectHash` (PLAN Sec10.6). */
export function message(domain: Domain, objectHash: Hex): Uint8Array {
  const domainBytes = toBytes(DOMAINS[domain]);
  const hashBytes = toBytes(objectHash);
  const out = new Uint8Array(domainBytes.length + 1 + hashBytes.length);
  out.set(domainBytes, 0);
  out.set(ZERO_BYTE, domainBytes.length);
  out.set(hashBytes, domainBytes.length + 1);
  return out;
}

/**
 * `ed25519` (RFC 8032): 32-byte secret-key seed in, 64-byte signature out.
 * `p256`: ECDSA over SHA-256(message bytes) with the library defaults —
 * `prehash: true`, `lowS: true`, `format: "compact"` — producing the
 * required `r‖s` 64-byte compact signature.
 */
export async function sign(alg: Alg, domain: Domain, objectHash: Hex, privKey: Hex): Promise<Hex> {
  const msg = message(domain, objectHash);
  const sk = toBytes(privKey);
  if (alg === "ed25519") {
    return toHex(ed.sign(msg, sk));
  }
  if (alg === "p256") {
    return toHex(p256.sign(msg, sk));
  }
  throw new Error(`unsupported signature algorithm ${String(alg)}`);
}

/**
 * `false` on any malformed input — wrong domain, wrong key, wrong alg, a
 * pubkey/signature of the wrong length or that fails to decode — rather
 * than throwing, so callers (notably `LogStore.revoke`) can treat every
 * failure mode uniformly.
 *
 * `ed25519`: `{ zip215: false }` is RFC 8032's strict branch — it rejects
 * non-canonical `S` and small-order points, which the more permissive
 * ZIP-215 default (this library's own default) would accept.
 * `p256`: the library defaults (`lowS: true`, `prehash: true`) reject a
 * high-`S` signature and hash the message with SHA-256 first.
 */
export async function verify(
  alg: Alg,
  domain: Domain,
  objectHash: Hex,
  sig: Hex,
  pubkey: Hex,
): Promise<boolean> {
  try {
    const msg = message(domain, objectHash);
    const sigBytes = toBytes(sig);
    const pubkeyBytes = toBytes(pubkey);
    if (alg === "ed25519") {
      if (pubkeyBytes.length !== 32 || sigBytes.length !== 64) return false;
      return ed.verify(sigBytes, msg, pubkeyBytes, { zip215: false });
    }
    if (alg === "p256") {
      if (pubkeyBytes.length !== 65 || pubkeyBytes[0] !== 0x04 || sigBytes.length !== 64) return false;
      return p256.verify(sigBytes, msg, pubkeyBytes, { lowS: true, prehash: true });
    }
    return false;
  } catch {
    return false;
  }
}

/** `keccak256(pubkeyBytes)` exactly as encoded (32-byte ed25519 key or 65-byte uncompressed p256 key). */
export function keyId(pubkey: Hex): Hex {
  return keccak256(pubkey);
}
