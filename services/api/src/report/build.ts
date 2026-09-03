/**
 * T-025 — Provenance Report builder (PLAN §9.6, §10.10, §21 step 6).
 *
 * Assembles the normative Report v1 JSON object for a corpus. Every proof
 * this function puts in the report — log inclusion, corpus inclusion, the
 * sealing→report consistency proof, and each episode's consent
 * (non-)membership proof — is folded and checked server-side, against the
 * exact roots the report itself names, before being included (PLAN §10.10,
 * I-11): a proof that does not verify aborts the whole report with a 500
 * naming the offending episode, rather than shipping something a buyer
 * would then discover is broken. Uses `packages/protocol/src/
 * report-verify.ts` for the fold/verify primitives — the same module
 * `report.test.ts`, and eventually `apps/web/verify.js` and T-033's CLI,
 * verify a finished report with, so the "build" and "check" sides of a
 * proof always agree on what "valid" means.
 */
import type { Hex } from "viem";
import type { ILogStore, EpisodeMeta } from "../../../log/src/store-interface.ts";
import type { CorpusManifest, CaptureManifest } from "../../../../packages/protocol/src/schemas.ts";
import { computeBadges, type AnchorInfo, type ConsentStatus, type VerificationClaim as BadgeClaim } from "../../../../packages/protocol/src/badges.ts";
import { SparseTree, ZERO as SMT_ZERO } from "../../../../packages/protocol/src/sparse.ts";
import { hashObjectExcluding, type JsonObject, type JsonValue } from "../../../../packages/protocol/src/canonical.ts";
import { root as ctRoot, inclusionProof as ctInclusionProof } from "../../../../packages/protocol/src/log.ts";
import { verifyInclusion, verifyConsistency } from "../../../../packages/protocol/src/report-verify.ts";
import { loadChecksConfig } from "../../../verify/src/config.ts";
import { ApiError } from "../errors.ts";
import { newUlid } from "../registry.ts";

/**
 * PLAN §22 — known limitations, verbatim in every report. Copied exactly
 * from PLAN.md; `report.test.ts` asserts string equality against the
 * source file so this can never silently drift.
 */
export const LIMITATIONS: readonly string[] = [
  "The operator (THENAR) can decline to log or anchor a record; append receipts and public audit make this detectable, not impossible.",
  "Checks are heuristics with recorded thresholds; they can be evaded and can err; they are evidence, not proof.",
  "A signature proves which key signed, not what a sensor measured; captured_at, source and embodiment are claims by the signer.",
  "Consent onset is recorded; what a buyer may do after onset is governed by the terms document, not by this protocol.",
  "Anchors depend on the availability of at least one chain carrying the log; the same log is anchored on more than one.",
];

export type BuildReportDeps = {
  logStore: ILogStore;
  /** Report §9.6 `operator` block — THENAR's own identity, not any episode's org. */
  operator: { name: string; verifierKeyId: Hex };
  /** unix seconds; overridable in tests. */
  now?: () => number;
  /** Maps a chain id to its display name for badge wording (PLAN §1 `{chain}`); defaults to `"chain {id}"`. */
  chainName?: (chainId: number) => string;
  /** Resolves a terms hash to its published URI; not every deployment has a terms registry wired up (PLAN §11.3 `termsAt` is on-chain, primary only) — defaults to always-unknown (`null`) rather than fabricating one (I-11). */
  termsUri?: (termsHash: Hex) => string | null;
  /**
   * Resolves `corpus.on_chain` (PLAN §9.6: `null | { chain_id, registry,
   * corpus_id, tx }`) for `corpusManifestHash` — the `LicenceRegistry`
   * `corpusCount`/`corpusAt` scan `GET /v1/corpora/{id}/onchain` already
   * does (`routes/corpora.ts`, `services/api/src/chain.ts`), pre-resolved
   * by the caller into a plain synchronous lookup so `buildReport` itself
   * stays synchronous (T-041d: adding a live RPC read here would make this
   * function async, which is this task's line to not cross — every current
   * caller, including the `/report` route, calls it synchronously).
   * Undefined by default — same behaviour as before this dep existed
   * (`on_chain: null`, not fabricated, I-11).
   */
  resolveOnChain?: (corpusManifestHash: Hex) => { chain_id: number; registry: Hex; corpus_id: string; tx: Hex } | null;
};

type AnchorRow = ReturnType<ILogStore["anchors"]>[number];
type ChainRow = ReturnType<ILogStore["anchorChains"]>[number];

function anchorObject(row: AnchorRow, chains: ChainRow[]) {
  return {
    root: row.root,
    size: row.size,
    revocation_root: row.revocationRoot,
    chains: chains.map((ch) => ({ chain_id: ch.chainId, index: ch.idx, block_number: ch.blockNumber, at: ch.at, tx: ch.txHash })),
  };
}

function primaryChain(chains: ChainRow[]): ChainRow {
  return [...chains].sort((a, b) => a.chainId - b.chainId)[0];
}

/**
 * PLAN §6.1 — the onset of *a* revocation is the first anchor whose
 * revocation root differs from the previous anchor's (starting from the
 * empty tree). This does not distinguish which key caused a given change
 * when more than one revocation has ever landed — the store keeps no
 * per-revocation "first anchor" (PLAN §8 `Revocation.firstAnchor` is not a
 * column any current table writes), and neither does `routes/consent.ts`'s
 * `GET /consent/{key}` onset lookup, which uses this exact same rule. A
 * report over a corpus with more than one revoked member episode may name
 * the wrong onset for a later revocation; fixing that needs a schema
 * change (a `revocation.first_anchor_idx` column) outside this task's
 * scope.
 */
function firstRevocationChangeAnchor(anchors: AnchorRow[]): AnchorRow | null {
  let prev: Hex = SMT_ZERO;
  for (const a of anchors) {
    if (a.revocationRoot !== prev) return a;
    prev = a.revocationRoot;
  }
  return null;
}

function parseManifest(meta: EpisodeMeta, leaf: Hex): CaptureManifest {
  if (!meta.manifest) throw new ApiError("internal", `episode ${leaf} has no stored manifest`);
  return JSON.parse(meta.manifest) as CaptureManifest;
}

/** Builds the normative Report v1 object (PLAN §9.6) for `corpusId`. Throws `ApiError` (never fabricates, I-11) when a required proof cannot be built or does not verify. */
export function buildReport(deps: BuildReportDeps, corpusId: string) {
  const { logStore } = deps;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const chainName = deps.chainName ?? ((id: number) => `chain ${id}`);
  const termsUri = deps.termsUri ?? (() => null);

  const row = logStore.corpusById(corpusId);
  if (!row) throw new ApiError("not_found", `no corpus ${corpusId}`);

  const manifest = JSON.parse(row.manifest) as CorpusManifest;
  const draft = row.manifestLeafHash === null || row.manifestLeafIdx === null;

  const anchors = logStore.anchors();
  if (anchors.length === 0) {
    throw new ApiError("conflict", "the log has not been anchored yet; no report can be built");
  }
  const reportAnchorRow = anchors[anchors.length - 1];
  const reportAnchorChains = logStore.anchorChains(reportAnchorRow.root, reportAnchorRow.size);
  if (reportAnchorChains.length === 0) {
    throw new ApiError("conflict", `report anchor (size ${reportAnchorRow.size}) has not reached any chain yet`);
  }

  let sealingAnchorRow: AnchorRow | null = null;
  let sealingAnchorChains: ChainRow[] = [];
  let consistencyProof: Hex[] = [];
  if (!draft) {
    const leafIdx = row.manifestLeafIdx as number;
    sealingAnchorRow = anchors.find((a) => a.size > leafIdx) ?? null;
    if (!sealingAnchorRow) throw new ApiError("conflict", "corpus manifest leaf has not been anchored yet");
    sealingAnchorChains = logStore.anchorChains(sealingAnchorRow.root, sealingAnchorRow.size);
    if (sealingAnchorChains.length === 0) throw new ApiError("conflict", "sealing anchor has not reached any chain yet");
    if (sealingAnchorRow.size !== reportAnchorRow.size) {
      consistencyProof = logStore.consistencyProof(sealingAnchorRow.size, reportAnchorRow.size);
      const ok = verifyConsistency(sealingAnchorRow.size, reportAnchorRow.size, consistencyProof, sealingAnchorRow.root, reportAnchorRow.root);
      if (!ok) throw new ApiError("internal", "sealing→report consistency proof does not verify");
    } else if (sealingAnchorRow.root !== reportAnchorRow.root) {
      throw new ApiError("internal", "sealing and report anchors have the same size but different roots");
    }
  }

  // ---- revocation SMT at the report anchor -------------------------------
  const revocations = logStore.revocations();
  const smt = new SparseTree();
  for (const r of revocations) smt.set(r.consentKey, r.value);
  if (revocations.length > 0 && smt.root() !== reportAnchorRow.revocationRoot) {
    throw new ApiError("internal", "computed revocation tree does not match the report anchor's revocation_root");
  }
  const revokedMap = new Map(revocations.map((r) => [r.consentKey, r.value]));
  const onsetAnchor = firstRevocationChangeAnchor(anchors);
  const onsetBlock = onsetAnchor ? primaryChain(logStore.anchorChains(onsetAnchor.root, onsetAnchor.size)).blockNumber : undefined;

  // ---- corpus tree --------------------------------------------------------
  const corpusEntries: { leafHash: Hex; corpusIndex: number }[] = draft
    ? (manifest.episodes as Hex[]).map((leaf, i) => ({ leafHash: leaf, corpusIndex: i }))
    : logStore.corpusEpisodeLeaves(corpusId);
  if (corpusEntries.length === 0) throw new ApiError("internal", `corpus ${corpusId} has no member episodes`);

  const corpusLeaves = corpusEntries.map((e) => e.leafHash);
  const recomputedCorpusRoot = ctRoot(corpusLeaves);
  if (recomputedCorpusRoot !== row.corpusRoot) {
    throw new ApiError("internal", "recomputed corpus_root does not match the stored corpus row");
  }

  const checksConfig = loadChecksConfig();
  const containsRevokedList: Hex[] = [];
  const checksRunMap = new Map<string, { check: string; check_version: string; thresholds: JsonValue }>();

  const episodes = corpusEntries.map((entry) => {
    const leaf = entry.leafHash;
    const meta = logStore.episodeMeta(leaf);
    if (!meta || meta.preimage === null) throw new ApiError("internal", `episode ${leaf} is missing from the log`);
    const logIndex = meta.index;
    if (logIndex >= reportAnchorRow.size) {
      throw new ApiError("conflict", `episode ${leaf} is not yet covered by the report anchor (size ${reportAnchorRow.size})`);
    }

    const inclusionProofLog = logStore.inclusionProof(logIndex, reportAnchorRow.size);
    if (!verifyInclusion(leaf, logIndex, reportAnchorRow.size, inclusionProofLog, reportAnchorRow.root)) {
      throw new ApiError("internal", `episode ${leaf}: log inclusion proof does not verify against the report anchor (I-11)`);
    }

    const inclusionProofCorpus = ctInclusionProof(corpusLeaves, entry.corpusIndex);
    if (!verifyInclusion(leaf, entry.corpusIndex, corpusLeaves.length, inclusionProofCorpus, row.corpusRoot)) {
      throw new ApiError("internal", `episode ${leaf}: corpus inclusion proof does not verify against corpus_root (I-11)`);
    }

    const captureManifest = parseManifest(meta, leaf);
    const consentKeyHex = meta.consentKey;
    if (!consentKeyHex) throw new ApiError("internal", `episode ${leaf} has no consent_key recorded`);
    const isRevoked = revokedMap.has(consentKeyHex);
    if (isRevoked) containsRevokedList.push(leaf);
    const { bitmap, siblings } = smt.proof(consentKeyHex);
    const consentFoldValue = isRevoked ? (revokedMap.get(consentKeyHex) as Hex) : SMT_ZERO;

    const claimRows = logStore.claimsFor(leaf);
    const claims = claimRows.map((cr) => {
      const claimLogIndex = logStore.indexOfLeaf(cr.leafHash);
      let detail: JsonValue;
      try {
        detail = JSON.parse(cr.detail) as JsonValue;
      } catch {
        throw new ApiError("internal", `episode ${leaf}: claim ${cr.check} carries undecodable detail JSON`);
      }
      const detailObj = detail as JsonObject;
      if (!detailObj || typeof detailObj !== "object" || !("thresholds" in detailObj)) {
        throw new ApiError("internal", `episode ${leaf}: claim ${cr.check} is missing detail.thresholds (I-15)`);
      }
      if (claimLogIndex !== null) {
        if (claimLogIndex >= reportAnchorRow.size) {
          throw new ApiError("internal", `episode ${leaf}: claim ${cr.check} leaf is not covered by the report anchor`);
        }
        const claimProof = logStore.inclusionProof(claimLogIndex, reportAnchorRow.size);
        if (!verifyInclusion(cr.leafHash, claimLogIndex, reportAnchorRow.size, claimProof, reportAnchorRow.root)) {
          throw new ApiError("internal", `episode ${leaf}: claim ${cr.check} inclusion proof does not verify (I-11)`);
        }
      }
      const checkVersion = typeof detailObj.check_version === "string" ? detailObj.check_version : "";
      checksRunMap.set(`${cr.check}:${checkVersion}`, { check: cr.check, check_version: checkVersion, thresholds: detailObj.thresholds as JsonValue });
      return {
        check: cr.check,
        result: cr.result,
        leaf: cr.leafHash,
        log_index: claimLogIndex,
        verifier_key_id: cr.verifierKeyId,
        detail_hash: cr.detailHash,
        detail: detailObj,
      };
    });

    const anchorChainRow = primaryChain(reportAnchorChains);
    const anchorInfo: AnchorInfo = { chain: chainName(anchorChainRow.chainId), block: String(anchorChainRow.blockNumber), size: String(reportAnchorRow.size) };
    const consentStatus: ConsentStatus = isRevoked
      ? { status: "revoked", onset: onsetBlock !== undefined ? String(onsetBlock) : "0" }
      : { status: "live" };
    const badgeClaims: BadgeClaim[] = claimRows.map((cr) => ({
      check: cr.check, result: cr.result as "pass" | "fail" | "inconclusive", issued_at: cr.issuedAt,
      detail: cr.detail ? { summary: cr.detail } : undefined,
    }));
    const hasVideoChannel = captureManifest.channels.some((ch) => ch.dtype.startsWith("video"));
    const badgeResult = computeBadges({
      anchored: anchorInfo,
      consent: consentStatus,
      // Signature/attestation (L1/L2) require a signing-key registry lookup
      // this builder does not have wired in yet (T-024's `Registry`); T-025's
      // scope is the report shape and its proofs, not badge inputs beyond
      // what `episodes.ts` already resolves — left `null` here, same as
      // that route's own current state, rather than fabricated (I-11).
      signature: null,
      attestation: null,
      claims: badgeClaims,
      checksConfig,
      source: { declared: captureManifest.source, attestation: null, hasVideoChannel },
    });

    return {
      leaf, log_index: logIndex, corpus_index: entry.corpusIndex,
      badges: badgeResult.badges, wording: badgeResult.wording,
      source: captureManifest.source,
      manifest_hash: meta.manifestHash, payload_hash: meta.payloadHash, preimage: meta.preimage,
      files: captureManifest.files.map((f) => ({ path: f.path, bytes: f.bytes, hash: f.hash })),
      range: captureManifest.range,
      inclusion_proof_log: inclusionProofLog,
      inclusion_proof_corpus: inclusionProofCorpus,
      consent: {
        key: consentKeyHex,
        // PLAN §6: "the supplier organisation under W1 (`holder:
        // "organisation"`)" — the ConsentRecord itself is never persisted
        // (§10.5/I-6: only `consentKey` and, on revoke, `value` are
        // stored), so the holder cannot be read back from a row; this
        // report is W1's own product, whose ingest path always attributes
        // consent to the org (same default `routes/episodes.ts` already
        // uses).
        holder: "organisation" as const,
        status: isRevoked ? "revoked" as const : "live" as const,
        ...(isRevoked ? { value: consentFoldValue } : {}),
        bitmap: bitmap.toString(),
        siblings,
        ...(isRevoked && onsetBlock !== undefined ? { onset: { block: onsetBlock } } : {}),
      },
      claims,
    };
  });

  const containsRevoked = containsRevokedList.length > 0;

  const corpusBlock = {
    id: row.corpusId,
    manifest_hash: row.corpusManifestHash,
    corpus_root: row.corpusRoot,
    episode_count: corpusEntries.length,
    terms: { hash: manifest.terms_hash, uri: termsUri(manifest.terms_hash as Hex) },
    contains_revoked: containsRevoked,
    // `deps.resolveOnChain` (added T-041d) lets a caller that already has a
    // live `LicenceRegistry` scan (`GET /v1/corpora/{id}/onchain`'s own
    // `corpusCount`/`corpusAt` loop) hand the match straight in; no current
    // caller wires it yet (the `/report` route builds `deps` with only
    // `logStore`/`operator`), so this stays `null` there today — not
    // fabricated (I-11) rather than partially filled in.
    on_chain: deps.resolveOnChain?.(row.corpusManifestHash) ?? null,
    draft,
  };

  const reportWithoutHash = {
    v: 1 as const,
    kind: "provenance_report" as const,
    report_id: newUlid(now() * 1000),
    generated_at: now(),
    operator: { name: deps.operator.name, verifier_key_id: deps.operator.verifierKeyId },
    corpus: corpusBlock,
    anchor: anchorObject(reportAnchorRow, reportAnchorChains),
    sealing_anchor: sealingAnchorRow ? anchorObject(sealingAnchorRow, sealingAnchorChains) : null,
    consistency_proof: consistencyProof,
    episodes,
    receipts: [] as unknown[],
    checks_run: Array.from(checksRunMap.values()),
    limitations: LIMITATIONS,
  };

  const reportHash = hashObjectExcluding(reportWithoutHash as unknown as JsonObject, ["report_hash"]);
  return { ...reportWithoutHash, report_hash: reportHash };
}
