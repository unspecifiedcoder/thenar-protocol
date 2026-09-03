/**
 * T-035 -- PLAN §9 zod schemas, `validateManifest`, and the §10.12
 * CaptureManifest -> EpisodeLeaf mapping.
 *
 * One valid fixture per schema, every listed rejection, every §10.12 row
 * asserted on the decoded preimage bytes, and `corpusRootOf`'s order
 * handling.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { keccak256, toHex, type Hex } from "viem";
import {
  CaptureManifestSchema,
  CorpusManifestSchema,
  VerificationClaimSchema,
  ConsentRecordSchema,
  AppendReceiptSchema,
  validateManifest,
  type CaptureManifest,
} from "../src/schemas";
import { manifestHash, corpusManifestHash, manifestToEpisode, corpusRootOf } from "../src/mapping";
import { encodeEpisode, EPISODE_PREIMAGE_BYTES } from "../src/episode";
import { root as ctRoot } from "../src/log";

let fails = 0;
const ok = (c: boolean, m: string, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` -- ${x}` : ""}`); };
const h = (s: string): Hex => keccak256(toHex(s));

const here = dirname(fileURLToPath(import.meta.url));
const manifestFixture: unknown = JSON.parse(readFileSync(join(here, "fixtures/manifest.json"), "utf8"));

// =============================================================================
// 9.1 CaptureManifest -- one valid fixture, then every listed rejection.
// =============================================================================
{
  const parsed = CaptureManifestSchema.safeParse(manifestFixture);
  ok(parsed.success, "CaptureManifest: valid fixture parses", parsed.success ? "" : JSON.stringify((parsed as { error: unknown }).error));

  const withChainId = { ...(manifestFixture as Record<string, unknown>), chain_id: 43113 };
  ok(!CaptureManifestSchema.safeParse(withChainId).success, "CaptureManifest: chain_id is rejected (I-7 closed schema, §27 trap #19)");

  const m = manifestFixture as any;
  const unsortedFiles = { ...m, files: [m.files[1], m.files[0]] };
  ok(!CaptureManifestSchema.safeParse(unsortedFiles).success, "CaptureManifest: unsorted files[] is rejected");

  const dupFiles = { ...m, files: [m.files[0], m.files[0]] };
  ok(!CaptureManifestSchema.safeParse(dupFiles).success, "CaptureManifest: duplicate files[] entries are rejected");

  const unsortedChannels = { ...m, channels: [m.channels[1], m.channels[0], m.channels[2]] };
  ok(!CaptureManifestSchema.safeParse(unsortedChannels).success, "CaptureManifest: unsorted channels[] is rejected");

  const dupChannels = { ...m, channels: [m.channels[0], m.channels[0]] };
  ok(!CaptureManifestSchema.safeParse(dupChannels).success, "CaptureManifest: duplicate channels[] entries are rejected");

  const badPath = { ...m, files: [{ ...m.files[0], path: "/etc/passwd" }, m.files[1]] };
  ok(!CaptureManifestSchema.safeParse(badPath).success, "CaptureManifest: a leading-/ path is rejected (§9.1 path rule)");

  const dotdotPath = { ...m, files: [{ ...m.files[0], path: "../escape/file.bin" }, m.files[1]] };
  ok(!CaptureManifestSchema.safeParse(dotdotPath).success, "CaptureManifest: a .. path segment is rejected");

  const chunkedNoRange = { ...m, layout: "chunked", range: null };
  ok(!CaptureManifestSchema.safeParse(chunkedNoRange).success, "CaptureManifest: layout=chunked without range is rejected");

  const chunkedWithRange = {
    ...m, layout: "chunked",
    range: { episode_index: 0, frames: [0, 100] },
  };
  ok(CaptureManifestSchema.safeParse(chunkedWithRange).success, "CaptureManifest: layout=chunked with range parses");

  const badWorldSeed = { ...m, sim: { task_spec_hash: h("task-spec"), world_seed: "18446744073709551616" } }; // 2^64
  ok(!CaptureManifestSchema.safeParse(badWorldSeed).success, "CaptureManifest: sim.world_seed above uint64 max is rejected");

  const nonDecimalWorldSeed = { ...m, sim: { task_spec_hash: h("task-spec"), world_seed: "12abc" } };
  ok(!CaptureManifestSchema.safeParse(nonDecimalWorldSeed).success, "CaptureManifest: sim.world_seed that is not a decimal string is rejected");

  const okWorldSeed = { ...m, sim: { task_spec_hash: h("task-spec"), world_seed: "18446744073709551615" } }; // uint64 max
  ok(CaptureManifestSchema.safeParse(okWorldSeed).success, "CaptureManifest: sim.world_seed at exactly uint64 max parses");
}

// --- validateManifest: recomputes payloadHash(files) and rejects a mismatch.
{
  const good = validateManifest(manifestFixture);
  ok(good.ok, "validateManifest: accepts the fixture whose payload_hash matches its files", good.ok ? "" : JSON.stringify((good as { issues: unknown }).issues));

  const tampered = { ...(manifestFixture as Record<string, unknown>), payload_hash: h("not-the-real-payload-hash") };
  const bad = validateManifest(tampered);
  ok(!bad.ok, "validateManifest: rejects a payload_hash that does not match payloadHash(files)");

  const structurallyInvalid = { ...(manifestFixture as Record<string, unknown>), chain_id: 43113 };
  ok(!validateManifest(structurallyInvalid).ok, "validateManifest: still enforces the closed schema (chain_id)");
}

// =============================================================================
// 9.2 CorpusManifest
// =============================================================================
{
  const validCorpus = {
    v: 1, kind: "corpus_manifest", org_id: "org_supplier", title: "demo corpus",
    episodes: [h("episode-a"), h("episode-b")], corpus_root: h("corpus-root"), episode_count: 2,
    terms_hash: h("terms"), task_id: null,
    filters: { min_badges: ["L0"], exclude_failed_checks: true },
    sealed_at: 1756900000,
  };
  ok(CorpusManifestSchema.safeParse(validCorpus).success, "CorpusManifest: valid fixture parses");

  const withChainId = { ...validCorpus, chain_id: 43113 };
  ok(!CorpusManifestSchema.safeParse(withChainId).success, "CorpusManifest: chain_id is rejected");

  const dupEpisodes = { ...validCorpus, episodes: [h("episode-a"), h("episode-a")] };
  ok(!CorpusManifestSchema.safeParse(dupEpisodes).success, "CorpusManifest: duplicate episodes[] is rejected");

  ok(corpusManifestHash(validCorpus as any).length === 66, "corpusManifestHash: produces a 32-byte hash");
}

// =============================================================================
// 9.3 VerificationClaim
// =============================================================================
{
  const validClaim = {
    v: 1, kind: "verification_claim", subject_leaf: h("subject"), verifier_key_id: h("verifier"),
    check: "dedup.v1", result: "pass", level_asserted: 3,
    detail: { check_version: "1.0.0", thresholds: { max_similarity: 0.9 } },
    issued_at: 1756900000, signature: { alg: "ed25519", key_id: h("verifier"), sig: "0xabcd" },
  };
  ok(VerificationClaimSchema.safeParse(validClaim).success, "VerificationClaim: valid fixture parses");

  const withChainId = { ...validClaim, chain_id: 43113 };
  ok(!VerificationClaimSchema.safeParse(withChainId).success, "VerificationClaim: chain_id is rejected");

  const noThresholds = { ...validClaim, detail: { check_version: "1.0.0" } };
  ok(!VerificationClaimSchema.safeParse(noThresholds).success, "VerificationClaim: missing detail.thresholds is rejected (I-15)");

  const badCheck = { ...validClaim, check: "not_a_real_check.v1" };
  ok(!VerificationClaimSchema.safeParse(badCheck).success, "VerificationClaim: unknown check name is rejected");
}

// =============================================================================
// 9.4 ConsentRecord
// =============================================================================
{
  const validConsent = {
    v: 1, kind: "consent_record", holder: "contributor", pubkey: h("pubkey"),
    alg: "ed25519", scope_bits: 11, terms_hash: h("terms"), granted_at: 1756900000,
    nonce: "0x" + "ab".repeat(16),
  };
  ok(ConsentRecordSchema.safeParse(validConsent).success, "ConsentRecord: valid fixture parses");

  const withChainId = { ...validConsent, chain_id: 43113 };
  ok(!ConsentRecordSchema.safeParse(withChainId).success, "ConsentRecord: chain_id is rejected");

  const shortNonce = { ...validConsent, nonce: "0xab" };
  ok(!ConsentRecordSchema.safeParse(shortNonce).success, "ConsentRecord: a nonce shorter than 16 bytes is rejected");
}

// =============================================================================
// 9.5 AppendReceipt
// =============================================================================
{
  const validReceipt = {
    v: 1, kind: "append_receipt", leaf_hash: h("leaf"), leaf_index: 17, log_size_after: 18,
    received_at: 1756900000, signature: { alg: "ed25519", key_id: h("verifier"), sig: "0xabcd" },
  };
  ok(AppendReceiptSchema.safeParse(validReceipt).success, "AppendReceipt: valid fixture parses");

  const withChainId = { ...validReceipt, chain_id: 43113 };
  ok(!AppendReceiptSchema.safeParse(withChainId).success, "AppendReceipt: chain_id is rejected");

  const badKind = { ...validReceipt, kind: "capture_manifest" };
  ok(!AppendReceiptSchema.safeParse(badKind).success, "AppendReceipt: wrong kind literal is rejected");
}

// =============================================================================
// manifestHash -- hashObjectExcluding(m, ["signature"])
// =============================================================================
{
  const unsigned = manifestFixture as CaptureManifest;
  const signed: CaptureManifest = { ...unsigned, signature: { alg: "ed25519", key_id: h("key"), sig: "0xdeadbeef" } };
  ok(manifestHash(unsigned) === manifestHash(signed), "manifestHash: excludes the signature field");
  ok(manifestHash(unsigned).length === 66, "manifestHash: produces a 32-byte hash");
}

// =============================================================================
// §10.12 -- CaptureManifest -> EpisodeLeaf (0x02) mapping, normative.
// Every row asserted on the decoded preimage bytes (byte offsets are the
// contract's -- see episode.ts).
// =============================================================================
const at = (raw: string, off: number, len: number) => `0x${raw.slice(off * 2, (off + len) * 2)}`;

{
  const base = manifestFixture as CaptureManifest;
  const withTaskId: CaptureManifest = {
    ...base,
    task: { instruction: "fold the towel", task_id: h("explicit-task-id") },
    sim: { task_spec_hash: h("spec"), world_seed: "18446744073709551615" },
    outcome: { success: true },
  };
  const submittedAt = 1787000060n;
  const episode = manifestToEpisode(withTaskId, submittedAt);
  const pre = encodeEpisode(episode);
  ok((pre.length - 2) / 2 === EPISODE_PREIMAGE_BYTES, "manifestToEpisode: encodes to exactly 197 bytes");
  const raw = pre.slice(2);

  ok(pre.slice(0, 4) === "0x02", "row: version -- 0x02");
  ok(at(raw, 1, 32) === withTaskId.payload_hash, "row: payloadHash -- manifest.payload_hash");
  ok(episode.manifestHash === manifestHash(withTaskId), "row: manifestHash -- hashObjectExcluding(manifest, [\"signature\"])");
  ok(at(raw, 65, 32) === withTaskId.consent_commitment, "row: consentCommitment -- manifest.consent_commitment");
  ok(at(raw, 97, 32) === withTaskId.terms_hash, "row: termsId -- manifest.terms_hash");
  ok(at(raw, 129, 32) === h("explicit-task-id"), "row: taskId -- manifest.task.task_id when set");
  ok(BigInt(at(raw, 161, 8)) === BigInt(withTaskId.captured_at), "row: capturedAt -- manifest.captured_at");
  ok(BigInt(at(raw, 169, 8)) === submittedAt, "row: submittedAt -- server receive time, not the manifest's own field (§27 trap #7)");
  ok(BigInt(at(raw, 169, 8)) !== BigInt(withTaskId.captured_at), "row: submittedAt is never taken from the manifest");
  ok(Number(BigInt(at(raw, 177, 4))) === withTaskId.duration_ms, "row: durationMs -- manifest.duration_ms");
  ok(Number(BigInt(at(raw, 181, 4))) === withTaskId.scope_bits, "row: scopeBits -- manifest.scope_bits");
  ok(Number(BigInt(at(raw, 185, 1))) === withTaskId.channels.length, "row: channels -- min(len(manifest.channels), 255)");
  ok(BigInt(at(raw, 186, 8)) === 18446744073709551615n, "row: worldSeed -- BigInt(manifest.sim.world_seed) when sim is set");
  ok(Number(BigInt(at(raw, 194, 1))) === 1, "row: successFlag -- manifest.outcome.success ? 1 : 0");
  ok(Number(BigInt(at(raw, 195, 2))) === 0, "row: qualityScore -- 0 (reserved in v2)");
}

// taskId fallback chain, three cases.
{
  const base = manifestFixture as CaptureManifest;
  const withInstruction: CaptureManifest = { ...base, task: { instruction: "fold the towel", task_id: null } };
  const epByInstruction = manifestToEpisode(withInstruction, 1n);
  ok(epByInstruction.taskId === h("fold the towel"), "taskId fallback: H(utf8(instruction)) when task_id is null");

  const withNoTask: CaptureManifest = { ...base, task: null };
  const epNoTask = manifestToEpisode(withNoTask, 1n);
  ok(epNoTask.taskId === ("0x" + "00".repeat(32)), "taskId fallback: 0^32 when task is null");
}

// worldSeed / successFlag defaults when sim/outcome are absent.
{
  const base = manifestFixture as CaptureManifest;
  const noSimNoOutcome: CaptureManifest = { ...base, sim: null, outcome: null };
  const ep = manifestToEpisode(noSimNoOutcome, 1n);
  ok(ep.worldSeed === 0n, "worldSeed defaults to 0 when sim is null");
  ok(ep.successFlag === 0, "successFlag defaults to 0 when outcome is null");
  ok(ep.qualityScore === 0, "qualityScore is always 0 (reserved in v2)");
}

// channels = min(len, 255): manifestToEpisode operates on the typed struct
// directly, so a >255-channel array (which CaptureManifestSchema's sorted
// array would never actually contain in practice) still round-trips through
// the clamp rather than overflowing the leaf's single channels byte.
{
  const base = manifestFixture as CaptureManifest;
  const manyChannels: CaptureManifest = {
    ...base,
    channels: Array.from({ length: 300 }, (_, i) => ({ name: `ch_${String(i).padStart(4, "0")}`, dtype: "float32", shape: [1] })),
  };
  const ep = manifestToEpisode(manyChannels, 1n);
  ok(ep.channels === 255, "channels clamps to 255 when manifest.channels.length exceeds it", String(ep.channels));
}

// =============================================================================
// corpusRootOf -- §10.7. Leaf hashes used directly as level-0 nodes (no
// extra 0x00); sorts by the caller-supplied logIndex rather than trusting
// array order; throws on empty input and on duplicates.
// =============================================================================
{
  const leaves = [h("ep-0"), h("ep-1"), h("ep-2")];
  const inOrder = leaves.map((leaf, logIndex) => ({ leaf, logIndex }));
  const shuffled = [inOrder[2], inOrder[0], inOrder[1]];

  const expected = ctRoot(leaves); // leaves used directly as level-0 nodes, ascending log index
  ok(corpusRootOf(inOrder) === expected, "corpusRootOf: matches ctRoot(leaves) directly (leaves are already leaf hashes)");
  ok(corpusRootOf(shuffled) === expected, "corpusRootOf: sorts by logIndex, independent of input array order");

  let threwEmpty = false;
  try { corpusRootOf([]); } catch { threwEmpty = true; }
  ok(threwEmpty, "corpusRootOf: throws on an empty episode list");

  let threwDupLeaf = false;
  try { corpusRootOf([{ leaf: leaves[0], logIndex: 0 }, { leaf: leaves[0], logIndex: 1 }]); } catch { threwDupLeaf = true; }
  ok(threwDupLeaf, "corpusRootOf: throws on a duplicate leaf");

  let threwDupIndex = false;
  try { corpusRootOf([{ leaf: leaves[0], logIndex: 0 }, { leaf: leaves[1], logIndex: 0 }]); } catch { threwDupIndex = true; }
  ok(threwDupIndex, "corpusRootOf: throws on a duplicate logIndex");

  ok(corpusRootOf([{ leaf: leaves[0], logIndex: 5 }]) === leaves[0], "corpusRootOf: a single episode's root is its own leaf hash");
}

console.log(fails === 0 ? "\nschemas: all checks passed\n" : `\n${fails} check(s) failed\n`);
process.exit(fails ? 1 : 0);
