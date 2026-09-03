/* leaves.js — decode leaf preimages 0x01–0x04 by offset, and hash them.
 *
 * Layouts are PLAN §10.3 (frozen 0x01/0x02, this v2.1's 0x03/0x04); each
 * decoder asserts the exact byte length before reading any field, the same
 * discipline `LeafVerifier.hashLeaf` uses on chain (`WrongLengthForVersion`).
 * `verify.test.mjs` checks every version against
 * `packages/protocol/test/fixtures/vectors.json`.
 */
import { keccak256 } from "./keccak.js";

const strip0x = (h) => h.replace(/^0x/, "");
const at = (raw, off, len) => "0x" + raw.slice(off * 2, (off + len) * 2);
const u = (raw, off, len) => BigInt(at(raw, off, len));

export const LEAF_VERSIONS = {
  0x01: { name: "ClipLeaf", bytes: 154 },
  0x02: { name: "EpisodeLeaf", bytes: 197 },
  0x03: { name: "CorpusManifestLeaf", bytes: 145 },
  0x04: { name: "VerificationClaimLeaf", bytes: 141 },
};

/** RFC 6962 leaf hash — `H(0x00 ‖ preimage)`, PLAN §10.1. */
export function hashLeaf(preimage) {
  return keccak256("0x00" + strip0x(preimage));
}

/**
 * Decode any of the four preimage versions. Throws (with a message naming
 * the problem) rather than returning partial data on a wrong length or an
 * unknown version byte — this is what `LeafVerifier.hashLeaf` does with
 * `UnknownLeafVersion`/`WrongLengthForVersion`, and the page must fail the
 * same way, not guess.
 */
export function decodeLeaf(preimage) {
  const raw = strip0x(preimage);
  if (raw.length % 2 !== 0) throw new Error("preimage has an odd number of hex digits");
  const bytes = raw.length / 2;
  if (bytes === 0) throw new Error("empty preimage");
  const version = parseInt(raw.slice(0, 2), 16);
  const known = LEAF_VERSIONS[version];
  if (!known) throw new Error(`unknown leaf version 0x${version.toString(16).padStart(2, "0")}`);
  if (bytes !== known.bytes) {
    throw new Error(`${known.name} (0x${version.toString(16).padStart(2, "0")}) must be ${known.bytes} bytes, got ${bytes}`);
  }
  switch (version) {
    case 0x01: return decodeClip(raw);
    case 0x02: return decodeEpisode(raw);
    case 0x03: return decodeCorpus(raw);
    case 0x04: return decodeClaim(raw);
  }
}

/** 0x01 ClipLeaf, 154 B — frozen. */
function decodeClip(raw) {
  return {
    version: 0x01,
    kind: "ClipLeaf",
    payloadHash: at(raw, 1, 32),
    manifestHash: at(raw, 33, 32),
    consentCommitment: at(raw, 65, 32),
    termsId: at(raw, 97, 32),
    capturedAt: u(raw, 129, 8),
    submittedAt: u(raw, 137, 8),
    durationMs: Number(u(raw, 145, 4)),
    scopeBits: Number(u(raw, 149, 4)),
    channels: Number(u(raw, 153, 1)),
  };
}

/** 0x02 EpisodeLeaf, 197 B — frozen; field mapping PLAN §10.12. */
function decodeEpisode(raw) {
  return {
    version: 0x02,
    kind: "EpisodeLeaf",
    payloadHash: at(raw, 1, 32),
    manifestHash: at(raw, 33, 32),
    consentCommitment: at(raw, 65, 32),
    termsId: at(raw, 97, 32),
    taskId: at(raw, 129, 32),
    capturedAt: u(raw, 161, 8),
    submittedAt: u(raw, 169, 8),
    durationMs: Number(u(raw, 177, 4)),
    scopeBits: Number(u(raw, 181, 4)),
    channels: Number(u(raw, 185, 1)),
    worldSeed: u(raw, 186, 8),
    successFlag: Number(u(raw, 194, 1)),
    qualityScore: Number(u(raw, 195, 2)),
  };
}

/** 0x03 CorpusManifestLeaf, 145 B — PLAN §10.3. */
function decodeCorpus(raw) {
  const episodeCount = u(raw, 129, 8);
  if (episodeCount < 1n) throw new Error("CorpusManifestLeaf episodeCount must be >= 1");
  return {
    version: 0x03,
    kind: "CorpusManifestLeaf",
    corpusManifestHash: at(raw, 1, 32),
    corpusRoot: at(raw, 33, 32),
    termsHash: at(raw, 65, 32),
    taskId: at(raw, 97, 32),
    episodeCount,
    sealedAt: u(raw, 137, 8),
  };
}

/** 0x04 VerificationClaimLeaf, 141 B — PLAN §10.3. */
function decodeClaim(raw) {
  const result = Number(u(raw, 131, 1));
  const levelAsserted = Number(u(raw, 132, 1));
  if (result > 2) throw new Error(`VerificationClaimLeaf result ${result} out of range (0..2)`);
  if (levelAsserted > 4) throw new Error(`VerificationClaimLeaf levelAsserted ${levelAsserted} out of range (0..4)`);
  return {
    version: 0x04,
    kind: "VerificationClaimLeaf",
    subjectLeaf: at(raw, 1, 32),
    verifierKeyId: at(raw, 33, 32),
    detailHash: at(raw, 65, 32),
    signatureHash: at(raw, 97, 32),
    checkId: Number(u(raw, 129, 2)),
    result,
    levelAsserted,
    issuedAt: u(raw, 133, 8),
  };
}
