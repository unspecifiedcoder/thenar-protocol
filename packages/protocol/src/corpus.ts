import { keccak256, concatHex, toHex, type Hex } from "viem";

/**
 * The 145-byte corpus manifest preimage — one leaf that seals a corpus: which
 * episodes it contains (by root), under what terms, and when.
 *
 * Kept byte-identical to `CorpusLeaf.sol`. If these two ever disagree, every
 * corpus inclusion proof breaks silently, so the layout is asserted here as
 * well as there.
 */
export const CORPUS_VERSION = 3;
export const CORPUS_PREIMAGE_BYTES = 145;

export type CorpusLeaf = {
  corpusManifestHash: Hex;
  corpusRoot: Hex;
  termsHash: Hex;
  taskId: Hex;
  episodeCount: bigint;
  sealedAt: bigint;
};

const b = (v: bigint | number, bytes: number): Hex => toHex(BigInt(v), { size: bytes });

export function encodeCorpus(c: CorpusLeaf): Hex {
  if (c.episodeCount < 1n) throw new Error(`episodeCount must be >= 1, got ${c.episodeCount}`);
  const out = concatHex([
    b(CORPUS_VERSION, 1),
    c.corpusManifestHash, c.corpusRoot, c.termsHash, c.taskId,
    b(c.episodeCount, 8), b(c.sealedAt, 8),
  ]);
  const len = (out.length - 2) / 2;
  if (len !== CORPUS_PREIMAGE_BYTES) {
    throw new Error(`corpus preimage must be ${CORPUS_PREIMAGE_BYTES} bytes, got ${len}`);
  }
  return out;
}

/** The inverse of `encodeCorpus`; throws on wrong length, wrong version, or an invalid field. */
export function decodeCorpus(preimage: Hex): CorpusLeaf {
  const raw = preimage.replace(/^0x/, "");
  if (raw.length / 2 !== CORPUS_PREIMAGE_BYTES) {
    throw new Error(`corpus preimage must be ${CORPUS_PREIMAGE_BYTES} bytes, got ${raw.length / 2}`);
  }
  const version = Number(`0x${raw.slice(0, 2)}`);
  if (version !== CORPUS_VERSION) throw new Error(`unsupported version ${version}`);
  const at = (off: number, len: number) => `0x${raw.slice(off * 2, (off + len) * 2)}` as Hex;
  const episodeCount = BigInt(at(129, 8));
  if (episodeCount === 0n) throw new Error("episodeCount must be >= 1");
  return {
    corpusManifestHash: at(1, 32),
    corpusRoot: at(33, 32),
    termsHash: at(65, 32),
    taskId: at(97, 32),
    episodeCount,
    sealedAt: BigInt(at(137, 8)),
  };
}

/** RFC 6962 leaf hash, domain-separated so no interior node can pose as a leaf. */
export const corpusLeafHash = (preimage: Hex): Hex =>
  keccak256(concatHex(["0x00", preimage]));
