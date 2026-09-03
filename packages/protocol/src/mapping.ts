/**
 * The normative bridge between PLAN §9 JSON objects and §10/§11 leaf bytes:
 * `manifestHash`/`corpusManifestHash` (the commitments a manifest signs and
 * a receipt names), `manifestToEpisode` (§10.12 — the one place a
 * `CaptureManifest` becomes the 0x02 `Episode` struct `encodeEpisode`
 * consumes), and `corpusRootOf` (§10.7 — the corpus tree over episode leaf
 * hashes).
 */
import { keccak256, toHex, type Hex } from "viem";
import { hashObject, hashObjectExcluding, type JsonObject, type JsonValue } from "./canonical";
import { root as ctRoot } from "./log";
import type { Episode } from "./episode";
import type { CaptureManifest, CorpusManifest } from "./schemas";

/** `hashObjectExcluding(manifest, ["signature"])` — PLAN §9.1. */
export function manifestHash(m: CaptureManifest): Hex {
  return hashObjectExcluding(m as unknown as JsonObject, ["signature"]);
}

/** `hashObject(m)` — PLAN §9.2; a corpus manifest carries no signature to exclude. */
export function corpusManifestHash(m: CorpusManifest): Hex {
  return hashObject(m as unknown as JsonValue);
}

const ZERO_HEX32 = ("0x" + "00".repeat(32)) as Hex;

/**
 * PLAN §10.12 — CaptureManifest → EpisodeLeaf (0x02) mapping (normative).
 * `submittedAt` is the server's own receive time (§27 trap #7 — it is
 * never read from the manifest, which the client cannot be trusted to
 * report honestly).
 */
export function manifestToEpisode(m: CaptureManifest, submittedAt: bigint): Episode {
  const taskId: Hex = m.task?.task_id
    ? m.task.task_id
    : m.task?.instruction
      ? keccak256(toHex(m.task.instruction))
      : ZERO_HEX32;

  return {
    payloadHash: m.payload_hash as Hex,
    manifestHash: manifestHash(m),
    consentCommitment: m.consent_commitment as Hex,
    termsId: m.terms_hash as Hex,
    taskId,
    capturedAt: BigInt(m.captured_at),
    submittedAt,
    durationMs: m.duration_ms,
    scopeBits: m.scope_bits,
    channels: Math.min(m.channels.length, 255),
    worldSeed: m.sim ? BigInt(m.sim.world_seed) : 0n,
    successFlag: m.outcome?.success ? 1 : 0,
    qualityScore: 0,
  };
}

/**
 * PLAN §10.7 — corpus tree over episode leaf hashes, used directly as
 * level-0 nodes (no extra 0x00, §27 trap #3). The tree's order is
 * ascending log index, and a corpus manifest only carries leaf hashes, not
 * indices, so a plain `Hex[]` cannot express "in order" without trusting
 * the caller to have sorted silently (§26.3 — an ambiguous Merkle rule is
 * a STOP condition). `corpusRootOf` instead takes `{ leaf, logIndex }[]`
 * and sorts by `logIndex` itself, so the order is provably the log's order
 * rather than whatever order the caller happened to pass leaves in.
 */
export function corpusRootOf(entries: { leaf: Hex; logIndex: number }[]): Hex {
  if (entries.length === 0) throw new Error("corpusRootOf requires at least one episode");
  const sorted = [...entries].sort((a, b) => a.logIndex - b.logIndex);
  const seenLeaf = new Set<string>();
  const seenIndex = new Set<number>();
  for (const e of sorted) {
    if (seenLeaf.has(e.leaf)) throw new Error(`corpusRootOf: duplicate leaf ${e.leaf}`);
    if (seenIndex.has(e.logIndex)) throw new Error(`corpusRootOf: duplicate logIndex ${e.logIndex}`);
    seenLeaf.add(e.leaf);
    seenIndex.add(e.logIndex);
  }
  return ctRoot(sorted.map((e) => e.leaf));
}
