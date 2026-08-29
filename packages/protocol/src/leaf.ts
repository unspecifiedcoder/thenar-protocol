import { keccak256, concatHex, toHex, type Hex } from "viem";

/** Exactly 154 bytes. A leaf whose length can drift is a leaf whose hash means nothing. */
export const PREIMAGE_BYTES = 154;
export const LEAF_VERSION = 1;

export type Clip = {
  payloadHash: Hex;
  manifestHash: Hex;
  consentCommitment: Hex;
  termsId: Hex;
  capturedAt: bigint;
  submittedAt: bigint;
  durationMs: number;
  scopeBits: number;
  channels: number;
};

const b = (v: bigint | number, bytes: number): Hex =>
  toHex(BigInt(v), { size: bytes });

export function encodeClip(c: Clip): Hex {
  const out = concatHex([
    b(LEAF_VERSION, 1),
    c.payloadHash,
    c.manifestHash,
    c.consentCommitment,
    c.termsId,
    b(c.capturedAt, 8),
    b(c.submittedAt, 8),
    b(c.durationMs, 4),
    b(c.scopeBits, 4),
    b(c.channels, 1),
  ]);
  const len = (out.length - 2) / 2;
  if (len !== PREIMAGE_BYTES) {
    throw new Error(`preimage must be ${PREIMAGE_BYTES} bytes, got ${len}`);
  }
  return out;
}

/** RFC 6962 leaf hash: 0x00 prefix so no interior node can pose as a leaf. */
export function hashLeaf(preimage: Hex): Hex {
  return keccak256(concatHex(["0x00", preimage]));
}

export function clipLeaf(c: Clip): Hex {
  return hashLeaf(encodeClip(c));
}

/**
 * A consent commitment is salted afresh on every submission. A stable
 * pseudonymous identifier on chain is one no erasure request can ever undo.
 */
export function commitConsent(consentRecord: Hex, salt: Hex): Hex {
  return keccak256(concatHex([consentRecord, salt]));
}
