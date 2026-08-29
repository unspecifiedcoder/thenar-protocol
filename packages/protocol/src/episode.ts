import { keccak256, concatHex, toHex, type Hex } from "viem";

/**
 * The 197-byte episode preimage — the capture leaf plus what the foundry needs:
 * which task, which sampled world, whether it succeeded, and what it scored.
 *
 * Kept byte-identical to `EpisodeLeaf.sol`. If these two ever disagree, every
 * proof breaks silently, so the layout is asserted here as well as there.
 */
export const EPISODE_PREIMAGE_BYTES = 197;
export const EPISODE_VERSION = 2;

export type Episode = {
  payloadHash: Hex;
  manifestHash: Hex;
  consentCommitment: Hex;
  termsId: Hex;
  taskId: Hex;
  capturedAt: bigint;
  submittedAt: bigint;
  durationMs: number;
  scopeBits: number;
  channels: number;
  worldSeed: bigint;
  successFlag: number;
  qualityScore: number;
};

const b = (v: bigint | number, bytes: number): Hex => toHex(BigInt(v), { size: bytes });

export function encodeEpisode(e: Episode): Hex {
  if (e.qualityScore > 10000) throw new Error(`qualityScore ${e.qualityScore} exceeds 10000 bps`);
  const out = concatHex([
    b(EPISODE_VERSION, 1),
    e.payloadHash, e.manifestHash, e.consentCommitment, e.termsId, e.taskId,
    b(e.capturedAt, 8), b(e.submittedAt, 8),
    b(e.durationMs, 4), b(e.scopeBits, 4), b(e.channels, 1),
    b(e.worldSeed, 8), b(e.successFlag, 1), b(e.qualityScore, 2),
  ]);
  const len = (out.length - 2) / 2;
  if (len !== EPISODE_PREIMAGE_BYTES) {
    throw new Error(`episode preimage must be ${EPISODE_PREIMAGE_BYTES} bytes, got ${len}`);
  }
  return out;
}

/** RFC 6962 leaf hash, domain-separated so no interior node can pose as a leaf. */
export const hashEpisodeLeaf = (preimage: Hex): Hex =>
  keccak256(concatHex(["0x00", preimage]));

/** The fields a buyer filters on, decoded from the preimage. */
export function episodeFacts(preimage: Hex) {
  const raw = preimage.replace(/^0x/, "");
  if (raw.length / 2 !== EPISODE_PREIMAGE_BYTES) throw new Error("wrong preimage length");
  const at = (off: number, len: number) => `0x${raw.slice(off * 2, (off + len) * 2)}` as Hex;
  return {
    taskId: at(129, 32),
    worldSeed: BigInt(at(186, 8)),
    success: Number(BigInt(at(194, 1))) === 1,
    qualityScore: Number(BigInt(at(195, 2))),
  };
}
