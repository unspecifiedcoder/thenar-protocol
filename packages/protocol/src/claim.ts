import { keccak256, concatHex, toHex, type Hex } from "viem";

/**
 * The 141-byte verification claim preimage — one leaf per check result, tying
 * a verifier's signed opinion to the subject leaf it opined on.
 *
 * Kept byte-identical to `ClaimLeaf.sol`. If these two ever disagree, every
 * claim inclusion proof breaks silently, so the layout is asserted here as
 * well as there.
 */
export const CLAIM_VERSION = 4;
export const CLAIM_PREIMAGE_BYTES = 141;

export type ClaimLeaf = {
  subjectLeaf: Hex;
  verifierKeyId: Hex;
  detailHash: Hex;
  signatureHash: Hex;
  checkId: number;
  result: 0 | 1 | 2;
  levelAsserted: number;
  issuedAt: bigint;
};

const b = (v: bigint | number, bytes: number): Hex => toHex(BigInt(v), { size: bytes });

export function encodeClaim(c: ClaimLeaf): Hex {
  if (c.result > 2) throw new Error(`result ${c.result} out of range (0..2)`);
  if (c.levelAsserted > 4) throw new Error(`levelAsserted ${c.levelAsserted} out of range (0..4)`);
  if (c.checkId === 0) throw new Error("checkId must be nonzero");
  if (c.issuedAt === 0n) throw new Error("issuedAt must be nonzero");
  const out = concatHex([
    b(CLAIM_VERSION, 1),
    c.subjectLeaf, c.verifierKeyId, c.detailHash, c.signatureHash,
    b(c.checkId, 2), b(c.result, 1), b(c.levelAsserted, 1), b(c.issuedAt, 8),
  ]);
  const len = (out.length - 2) / 2;
  if (len !== CLAIM_PREIMAGE_BYTES) {
    throw new Error(`claim preimage must be ${CLAIM_PREIMAGE_BYTES} bytes, got ${len}`);
  }
  return out;
}

/** The inverse of `encodeClaim`; throws on wrong length, wrong version, or an invalid field. */
export function decodeClaim(preimage: Hex): ClaimLeaf {
  const raw = preimage.replace(/^0x/, "");
  if (raw.length / 2 !== CLAIM_PREIMAGE_BYTES) {
    throw new Error(`claim preimage must be ${CLAIM_PREIMAGE_BYTES} bytes, got ${raw.length / 2}`);
  }
  const version = Number(`0x${raw.slice(0, 2)}`);
  if (version !== CLAIM_VERSION) throw new Error(`unsupported version ${version}`);
  const at = (off: number, len: number) => `0x${raw.slice(off * 2, (off + len) * 2)}` as Hex;
  const result = Number(BigInt(at(131, 1)));
  const levelAsserted = Number(BigInt(at(132, 1)));
  const checkId = Number(BigInt(at(129, 2)));
  const issuedAt = BigInt(at(133, 8));
  if (result > 2) throw new Error(`result ${result} out of range (0..2)`);
  if (levelAsserted > 4) throw new Error(`levelAsserted ${levelAsserted} out of range (0..4)`);
  if (checkId === 0) throw new Error("checkId must be nonzero");
  if (issuedAt === 0n) throw new Error("issuedAt must be nonzero");
  return {
    subjectLeaf: at(1, 32),
    verifierKeyId: at(33, 32),
    detailHash: at(65, 32),
    signatureHash: at(97, 32),
    checkId,
    result: result as 0 | 1 | 2,
    levelAsserted,
    issuedAt,
  };
}

/** RFC 6962 leaf hash, domain-separated so no interior node can pose as a leaf. */
export const claimLeafHash = (preimage: Hex): Hex =>
  keccak256(concatHex(["0x00", preimage]));
