/**
 * T-008 — Emit Solidity test vectors + a self-describing JSON vector file
 * from the reference (TypeScript) implementation.
 *
 * PLAN §5 I-5: canonical serialisation is deterministic and TS/Solidity must
 * agree on every vector. This script is the only place that guarantee is
 * produced, so it is itself deterministic — fixed inputs, fixed TEST-ONLY
 * keys, no `Date.now()`, no randomness. Every value below is either a fixed
 * literal or computed from one.
 *
 * Writes:
 *   - packages/contracts/test/Vectors.sol   (consumed by the Solidity tests)
 *   - packages/protocol/test/fixtures/vectors.json (consumed here by nothing
 *     yet; kept self-describing — inputs alongside outputs — for the future
 *     Python SDK, PLAN §23)
 */
import { keccak256, toHex, toBytes, concatHex, type Hex } from "viem";
import { readFileSync, writeFileSync } from "node:fs";
import { encodeClip, commitConsent } from "../src/leaf";
import { encodeEpisode, hashEpisodeLeaf, type Episode } from "../src/episode";
import { encodeCorpus, corpusLeafHash, type CorpusLeaf } from "../src/corpus";
import { encodeClaim, claimLeafHash, type ClaimLeaf } from "../src/claim";
import * as log from "../src/log";
import { SparseTree, ZERO } from "../src/sparse";
import { fileLeaf, payloadHash, type FileEntry } from "../src/payload";
import {
  canonicalJson,
  hashObject,
  hashObjectExcluding,
  type JsonValue,
  type JsonObject,
} from "../src/canonical";
import { recordHash, consentKey, consentCommitment, revocationValue, type ConsentRecord } from "../src/consent";
import { DOMAINS, message, sign, keyId } from "../src/sign";
import { manifestHash as computeManifestHash, manifestToEpisode } from "../src/mapping";
import { validateManifest } from "../src/schemas";
import * as ed from "@noble/ed25519";
import { p256 } from "@noble/curves/nist.js";

const h = (s: string): Hex => keccak256(toHex(s));

// ==========================================================================
// §10.1/§10.2 — CT log and sparse-tree vectors (existing, unchanged shape)
// ==========================================================================

const N = 11;
const leaves: Hex[] = Array.from({ length: N }, (_, i) => h(`clip-${i}`));
const rootN = log.root(leaves);

const arr = (xs: Hex[]) => `[${xs.map((x) => `bytes32(${x})`).join(", ")}]`;

/** Solidity has no zero-length array literal, so an empty proof is its own case. */
const proofFn = (name: string, xs: Hex[]) =>
  xs.length === 0
    ? `    function ${name}() internal pure returns (bytes32[] memory p) {
        p = new bytes32[](0);
    }`
    : `    function ${name}() internal pure returns (bytes32[] memory p) {
        bytes32[${xs.length}] memory a = ${arr(xs)};
        p = new bytes32[](${xs.length});
        for (uint256 i; i < ${xs.length}; ++i) p[i] = a[i];
    }`;

const clip = {
  payloadHash: h("payload"),
  manifestHash: h("manifest"),
  consentCommitment: commitConsent(h("consent"), h("salt")),
  termsId: h("terms-v1"),
  capturedAt: 1787000000n,
  submittedAt: 1787000060n,
  durationMs: 4200,
  scopeBits: 0b1011,
  channels: 6,
};
const clipPreimage = encodeClip(clip);
const clipLeafHash = log.root([keccak256(concatHex(["0x00", clipPreimage]))]);

const incIdx = 4;
const inc = log.inclusionProof(leaves, incIdx);
const M = 7;
const rootM = log.root(leaves.slice(0, M));
const cons = log.consistencyProof(leaves, M, N);

const sTree = new SparseTree();
const revoked = h("consent-key-revoked");
const live = h("consent-key-live");
const revValue = h("revocation-record");
sTree.set(revoked, revValue);
const sRoot = sTree.root();
const pIn = sTree.proof(revoked);
const pOut = sTree.proof(live);

// ==========================================================================
// §10.3 — Leaves 0x02 (episode), 0x03 (corpus), 0x04 (claim)
// ==========================================================================

// §10.12 — 0x02 EpisodeLeaf, derived from the fixture manifest at a fixed
// (never-from-the-manifest, §27 trap #7) submittedAt.
const manifestFixturePath = "packages/protocol/test/fixtures/manifest.json";
const manifestRaw = JSON.parse(readFileSync(manifestFixturePath, "utf8"));
const validated = validateManifest(manifestRaw);
if (!validated.ok) {
  throw new Error(
    `fixtures/manifest.json failed validateManifest: ${JSON.stringify(validated.issues)}`,
  );
}
const manifest = validated.value;
const SUBMITTED_AT = 1756900060n; // fixed; strictly after manifest.captured_at (1756900000)

const manifestHashNoSig = computeManifestHash(manifest);
// Same manifest but with a (TEST-ONLY, never verified here) signature block
// attached, to prove manifestHash is identical with or without `signature`
// (PLAN §9.1: `manifestHash = hashObjectExcluding(manifest, ["signature"])`).
const manifestWithSig = {
  ...manifest,
  signature: { alg: "ed25519", key_id: h("test-only-key-id"), sig: h("test-only-sig") },
};
const manifestHashWithSig = computeManifestHash(manifestWithSig as typeof manifest);
if (manifestHashNoSig !== manifestHashWithSig) {
  throw new Error("manifestHash must be identical with and without `signature` (PLAN §9.1)");
}

const episode: Episode = manifestToEpisode(manifest, SUBMITTED_AT);
const episodePreimage = encodeEpisode(episode);
const episodeLeafHash = hashEpisodeLeaf(episodePreimage);

// 0x03 CorpusManifestLeaf — fixed test values (no corpus fixture in scope of T-008).
const corpus: CorpusLeaf = {
  corpusManifestHash: h("corpus-manifest"),
  corpusRoot: h("corpus-root"),
  termsHash: h("terms-v1"),
  taskId: h("task-mug-shelf"),
  episodeCount: 3n,
  sealedAt: 1787000100n,
};
const corpusPreimage = encodeCorpus(corpus);
const corpusLeafHashValue = corpusLeafHash(corpusPreimage);

// 0x04 VerificationClaimLeaf — fixed test values.
const claim: ClaimLeaf = {
  subjectLeaf: h("subject-leaf"),
  verifierKeyId: h("verifier-key"),
  detailHash: h("detail"),
  signatureHash: h("signature-bytes"),
  checkId: 3,
  result: 1,
  levelAsserted: 2,
  issuedAt: 1787000200n,
};
const claimPreimage = encodeClaim(claim);
const claimLeafHashValue = claimLeafHash(claimPreimage);

// ==========================================================================
// §10.4 — payloadHash / fileLeaf over the three committed fixture files
// ==========================================================================

const fileFixtures = [
  { path: "a.txt", fsPath: "packages/protocol/test/fixtures/files/a.txt" },
  { path: "b.bin", fsPath: "packages/protocol/test/fixtures/files/b.bin" },
  { path: "sub/c.parquet", fsPath: "packages/protocol/test/fixtures/files/sub/c.parquet" },
];
const fileEntries: FileEntry[] = fileFixtures.map((f) => {
  const bytes = readFileSync(f.fsPath);
  const hash = keccak256(new Uint8Array(bytes)) as Hex;
  return { path: f.path, bytes: bytes.length, hash };
});
// Bytewise-sorted by path (§10.4; §27 trap #2 — never localeCompare).
const sortedFileEntries = [...fileEntries].sort((a, b) =>
  Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")),
);
const fileLeaves = sortedFileEntries.map((f) => fileLeaf(f.path, f.hash));
const filesPayloadHash = payloadHash(fileEntries); // sorts internally; same result

// ==========================================================================
// §9 D-5 — a small JCS fixture (canonical string + hash), for cross-impl reuse
// ==========================================================================

const jcsSample: JsonValue = { b: 2, a: 1, nested: { z: true, list: [3, 1, 2] } };
const jcsCanonical = canonicalJson(jcsSample);
const jcsHash = hashObject(jcsSample);

// ==========================================================================
// §9.4/§10.5 — consent commitment, consentKey, revocationValue
// ==========================================================================

// TEST-ONLY 32-byte Ed25519 seed / P-256 private key. Fixed and deterministic
// — derived from a labelled string, never from randomness or the clock.
const ED25519_TEST_SK: Hex = keccak256(toHex("THENAR/T-008/TEST-ONLY/ed25519-seed-v1"));
const P256_TEST_SK: Hex = keccak256(toHex("THENAR/T-008/TEST-ONLY/p256-seed-v1"));

// `sign.ts` (imported above) already wires `ed.hashes.sha512` at module load,
// once, for the shared @noble/ed25519 module instance.
const edPubkey = toHex(ed.getPublicKey(toBytes(ED25519_TEST_SK)));
const edKeyId = keyId(edPubkey);
const p256Pubkey = toHex(p256.getPublicKey(toBytes(P256_TEST_SK), false));
const p256KeyId = keyId(p256Pubkey);

const consentRecord: ConsentRecord = {
  v: 1,
  kind: "consent_record",
  holder: "contributor",
  pubkey: edPubkey,
  alg: "ed25519",
  scope_bits: 11,
  terms_hash: h("terms-v1"),
  granted_at: 1756900000,
  nonce: ("0x" + "ab".repeat(16)) as Hex, // TEST-ONLY fixed nonce
};
const consentRecordHash = recordHash(consentRecord);
const consentKeyValue = consentKey(consentRecordHash);
const CONSENT_SALT: Hex = ("0x" + "cd".repeat(32)) as Hex; // TEST-ONLY fixed salt
const consentCommitmentValue = consentCommitment(consentRecordHash, CONSENT_SALT);
const consentRevocationValue = revocationValue(consentRecordHash);

// ==========================================================================
// §10.6 — the four signature message byte strings, and revoke signatures
// ==========================================================================

const claimObj: JsonObject = {
  v: 1,
  kind: "verification_claim",
  subject_leaf: claim.subjectLeaf,
  verifier_key_id: edKeyId,
  check: "dedup.v1",
  result: "pass",
  level_asserted: 1,
  detail: { check_version: "dedup.v1-2026-01-01", thresholds: { rho_min: 0.98 } },
  issued_at: 1787000200,
};
const claimObjectHash = hashObjectExcluding(claimObj, ["signature"]);

const receiptObj: JsonObject = {
  v: 1,
  kind: "append_receipt",
  leaf_hash: episodeLeafHash,
  leaf_index: 17,
  log_size_after: 18,
  received_at: 1787000300,
};
const receiptObjectHash = hashObjectExcluding(receiptObj, ["signature"]);

const msgManifest = message("manifest", manifestHashNoSig);
const msgRevoke = message("revoke", consentKeyValue);
const msgClaim = message("claim", claimObjectHash);
const msgAppendReceipt = message("append-receipt", receiptObjectHash);

// Fully deterministic (RFC 8032 / RFC 6979) — no randomness, so re-running
// this script reproduces byte-identical signatures.
const edSigRevoke = await sign("ed25519", "revoke", consentKeyValue, ED25519_TEST_SK);
const p256SigRevoke = await sign("p256", "revoke", consentKeyValue, P256_TEST_SK);

// ==========================================================================
// Emit packages/contracts/test/Vectors.sol
// ==========================================================================

const bytesHex = (x: Hex) => x.slice(2);

const sol = `// SPDX-License-Identifier: MIT
// GENERATED by packages/protocol/test/vectors.ts — do not edit by hand.
// These are produced by the off-chain reference implementation, so a passing
// test means the Solidity and the TypeScript agree on every hash.
pragma solidity ^0.8.24;

library Vectors {
    // ------------------------------------------------------- 0x01 ClipLeaf
    bytes constant CLIP_PREIMAGE = hex"${bytesHex(clipPreimage)}";
    bytes32 constant CLIP_LEAF = ${clipLeafHash};

    // ---------------------------------------------------- 0x02 EpisodeLeaf
    // Derived from fixtures/manifest.json via manifestToEpisode (§10.12) at
    // the fixed submittedAt below (never taken from the manifest itself).
    uint64 constant EPISODE_SUBMITTED_AT = ${SUBMITTED_AT};
    bytes32 constant MANIFEST_HASH = ${manifestHashNoSig};
    bytes constant EPISODE_PREIMAGE = hex"${bytesHex(episodePreimage)}";
    bytes32 constant EPISODE_LEAF = ${episodeLeafHash};

    // ----------------------------------------------- 0x03 CorpusManifestLeaf
    bytes constant CORPUS_PREIMAGE = hex"${bytesHex(corpusPreimage)}";
    bytes32 constant CORPUS_LEAF = ${corpusLeafHashValue};

    // ------------------------------------------- 0x04 VerificationClaimLeaf
    bytes constant CLAIM_PREIMAGE = hex"${bytesHex(claimPreimage)}";
    bytes32 constant CLAIM_LEAF = ${claimLeafHashValue};

    // ------------------------------------------ §10.4 fileLeaf / payloadHash
    // Three committed fixture files, bytewise-sorted by path.
    string constant FILE0_PATH = "${sortedFileEntries[0].path}";
    bytes32 constant FILE0_HASH = ${sortedFileEntries[0].hash};
    bytes32 constant FILE0_LEAF = ${fileLeaves[0]};

    string constant FILE1_PATH = "${sortedFileEntries[1].path}";
    bytes32 constant FILE1_HASH = ${sortedFileEntries[1].hash};
    bytes32 constant FILE1_LEAF = ${fileLeaves[1]};

    string constant FILE2_PATH = "${sortedFileEntries[2].path}";
    bytes32 constant FILE2_HASH = ${sortedFileEntries[2].hash};
    bytes32 constant FILE2_LEAF = ${fileLeaves[2]};

    bytes32 constant PAYLOAD_HASH = ${filesPayloadHash};

    // -------------------------------------------------------------- §10.1 CT
    uint64 constant N = ${N};
    bytes32 constant ROOT_N = ${rootN};
    uint64 constant INCLUSION_INDEX = ${incIdx};
    bytes32 constant INCLUSION_LEAF = ${leaves[incIdx]};

    uint64 constant M = ${M};
    bytes32 constant ROOT_M = ${rootM};

    // ------------------------------------------------------------ §10.2 SMT
    bytes32 constant SPARSE_ROOT = ${sRoot};
    bytes32 constant KEY_REVOKED = ${revoked};
    bytes32 constant VALUE_REVOKED = ${revValue};
    bytes32 constant KEY_LIVE = ${live};
    uint256 constant BITMAP_IN = ${pIn.bitmap};
    uint256 constant BITMAP_OUT = ${pOut.bitmap};

${proofFn("inclusionProof", inc)}

${proofFn("consistencyProof", cons)}

${proofFn("sparseIn", pIn.siblings)}

${proofFn("sparseOut", pOut.siblings)}
}
`;
writeFileSync("packages/contracts/test/Vectors.sol", sol);

// ==========================================================================
// Emit packages/protocol/test/fixtures/vectors.json
// ==========================================================================

const vectorsJson = {
  v: 1,
  generatedBy: "packages/protocol/test/vectors.ts",
  note:
    "Self-describing: every output is paired with the inputs it was computed " +
    "from, so a re-implementation (e.g. the Python SDK, PLAN §23) can " +
    "reproduce each value independently. Keys marked TEST-ONLY must never " +
    "be used outside this fixture set.",
  leaves: {
    clip_0x01: { preimage: clipPreimage, leaf: clipLeafHash, fields: clip },
    episode_0x02: {
      submittedAt: SUBMITTED_AT.toString(),
      manifestFixture: manifestFixturePath,
      manifestHash: manifestHashNoSig,
      manifestHashWithSignatureAttached: manifestHashWithSig,
      preimage: episodePreimage,
      leaf: episodeLeafHash,
      fields: {
        ...episode,
        capturedAt: episode.capturedAt.toString(),
        submittedAt: episode.submittedAt.toString(),
        worldSeed: episode.worldSeed.toString(),
      },
    },
    corpus_0x03: {
      preimage: corpusPreimage,
      leaf: corpusLeafHashValue,
      fields: {
        ...corpus,
        episodeCount: corpus.episodeCount.toString(),
        sealedAt: corpus.sealedAt.toString(),
      },
    },
    claim_0x04: {
      preimage: claimPreimage,
      leaf: claimLeafHashValue,
      fields: { ...claim, issuedAt: claim.issuedAt.toString() },
    },
  },
  payloadHash: {
    files: sortedFileEntries,
    fileLeaves,
    payloadHash: filesPayloadHash,
  },
  jcs: {
    input: jcsSample,
    canonical: jcsCanonical,
    hash: jcsHash,
  },
  consent: {
    record: consentRecord,
    recordHash: consentRecordHash,
    consentKey: consentKeyValue,
    salt: CONSENT_SALT,
    consentCommitment: consentCommitmentValue,
    revocationValue: consentRevocationValue,
  },
  signatures: {
    domains: DOMAINS,
    messages: {
      manifest: { domain: "manifest", objectHash: manifestHashNoSig, message: toHex(msgManifest) },
      revoke: { domain: "revoke", objectHash: consentKeyValue, message: toHex(msgRevoke) },
      claim: { domain: "claim", objectHash: claimObjectHash, message: toHex(msgClaim) },
      "append-receipt": {
        domain: "appendReceipt",
        objectHash: receiptObjectHash,
        message: toHex(msgAppendReceipt),
      },
    },
    revoke: {
      objectHash: consentKeyValue,
      ed25519: {
        note: "TEST-ONLY key — derived deterministically from a labelled string, never used in production",
        privateKeySeed: ED25519_TEST_SK,
        pubkey: edPubkey,
        keyId: edKeyId,
        signature: edSigRevoke,
      },
      p256: {
        note: "TEST-ONLY key — derived deterministically from a labelled string, never used in production",
        privateKeyScalar: P256_TEST_SK,
        pubkey: p256Pubkey,
        keyId: p256KeyId,
        signature: p256SigRevoke,
      },
    },
  },
  ct: {
    n: N,
    rootN,
    inclusionIndex: incIdx,
    inclusionLeaf: leaves[incIdx],
    inclusionProof: inc,
    m: M,
    rootM,
    consistencyProof: cons,
  },
  sparse: {
    sparseRoot: sRoot,
    keyRevoked: revoked,
    valueRevoked: revValue,
    keyLive: live,
    bitmapIn: pIn.bitmap.toString(),
    siblingsIn: pIn.siblings,
    bitmapOut: pOut.bitmap.toString(),
    siblingsOut: pOut.siblings,
  },
};

const jsonReplacer = (_key: string, value: unknown) =>
  typeof value === "bigint" ? value.toString() : value;

writeFileSync(
  "packages/protocol/test/fixtures/vectors.json",
  JSON.stringify(vectorsJson, jsonReplacer, 2) + "\n",
);

console.log(`wrote packages/contracts/test/Vectors.sol`);
console.log(`  log n=${N} root=${rootN.slice(0, 18)}…  inclusion proof ${inc.length} words`);
console.log(`  consistency ${M}->${N}: ${cons.length} words`);
console.log(`  sparse root=${sRoot.slice(0, 18)}…  in=${pIn.siblings.length} out=${pOut.siblings.length} words`);
console.log(`  episode leaf=${episodeLeafHash.slice(0, 18)}…  corpus leaf=${corpusLeafHashValue.slice(0, 18)}…  claim leaf=${claimLeafHashValue.slice(0, 18)}…`);
console.log(`  payloadHash=${filesPayloadHash.slice(0, 18)}… over ${sortedFileEntries.length} fixture files`);
console.log(`wrote packages/protocol/test/fixtures/vectors.json`);
