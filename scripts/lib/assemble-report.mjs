#!/usr/bin/env node
// --experimental-strip-types
/**
 * `scripts/lib/assemble-report.mjs` — T-033 supervisor adjustment (3).
 *
 * `GET /v1/corpora/{id}/report` (PLAN §12) is `notImplemented` right now —
 * T-025 (the real report generator) is being built concurrently. This
 * module assembles the same normative Report v1 object (PLAN §9.6) by
 * calling the API's own proof/consent/episode endpoints plus the shared
 * protocol library (`packages/protocol/src/log.ts`) for the one proof kind
 * no route exposes yet — corpus inclusion (PLAN §10.7, D-29: no indexer,
 * so this is computed client-side from the corpus's own public episode
 * list, exactly the way `apps/web/corpus.js`/`verify.js` would). Nothing
 * here is invented (I-11): every hash, root and proof is either read back
 * from the log service or recomputed from data the log service returned.
 *
 * When T-025 ships `GET /v1/corpora/{id}/report`, `scripts/golden.mjs`
 * swaps this module for a single `fetch` call — the call site in
 * `golden.mjs` is one line (`assembleReport(...)` → `fetchReport(...)`),
 * everything else (the Report v1 shape consumers) stays the same.
 *
 * Two facts the documented API surface does not yet return to a caller
 * are supplied by `golden.mjs` itself, read directly off the in-process
 * `LogStore` it already holds (same process, not fabricated — see
 * `TASKS/REPORTS.md`'s T-033 entry for why):
 *   - an episode's `consentKey` (the ingest-job path never returns the
 *     `ConsentRecord`/`consentKey` it derives — PLAN §10.5's "held by the
 *     holder/supplier" assumes the *caller* built the record, which the
 *     dataset-ingest flow does not let it do);
 *   - a claim leaf's own hash (`GET /episodes/{leaf}`'s `claims[]` carries
 *     `check/result/issued_at/detail/verifier_key_id` but not the 0x04
 *     claim leaf hash itself, so this module cannot ask `/proofs/inclusion`
 *     for it without being handed that hash).
 */
import { inclusionProof as ctInclusionProof } from "../../packages/protocol/src/log.ts";
import { l0Wording } from "../../packages/protocol/src/wording.ts";

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

/**
 * @param {object} args
 * @param {string} args.apiBase
 * @param {string} args.corpusId off-chain corpus id (`GET /v1/corpora/{id}`)
 * @param {{root:string,size:number}} args.reportAnchor the (root,size) this report is generated against
 * @param {{root:string,size:number}} args.sealingAnchor the (root,size) the corpus was sealed against
 * @param {{name:string, keyId:string}} args.operator
 * @param {{hash:string, uri:string}} args.terms
 * @param {Array<{leafHash:string, manifest:object, manifestHash:string, consentKey:string, claims:Array}>} args.episodes
 *   `claims[]` entries are `ClaimRow`-shaped: `{leafHash, check, result, detail, detailHash, verifierKeyId, issuedAt}`.
 * @param {string[]} args.limitations verbatim PLAN §22 text
 */
export async function assembleReport({
  apiBase, corpusId, reportAnchor, sealingAnchor, operator, terms, episodes, limitations,
}) {
  const base = apiBase.replace(/\/$/, "");

  const corpus = await getJson(`${base}/v1/corpora/${encodeURIComponent(corpusId)}`);
  const corpusLeaves = corpus.manifest.episodes; // ordered by log index (§9.2)

  const anchorsPage = await getJson(`${base}/v1/anchors?limit=500`);
  const findAnchor = (a) => anchorsPage.items.find((x) => x.root === a.root && x.size === a.size);
  const reportAnchorRow = findAnchor(reportAnchor);
  const sealingAnchorRow = findAnchor(sealingAnchor);
  if (!reportAnchorRow) throw new Error(`assembleReport: no anchor (root=${reportAnchor.root}, size=${reportAnchor.size}) in GET /v1/anchors`);
  if (!sealingAnchorRow) throw new Error(`assembleReport: no anchor (root=${sealingAnchor.root}, size=${sealingAnchor.size}) in GET /v1/anchors`);

  let consistencyProof = [];
  if (sealingAnchor.size !== reportAnchor.size) {
    const cp = await getJson(`${base}/v1/proofs/consistency?from_size=${sealingAnchor.size}&to_size=${reportAnchor.size}`);
    consistencyProof = cp.proof;
  }

  const episodeReports = [];
  for (const ep of episodes) {
    const detail = await getJson(`${base}/v1/episodes/${ep.leafHash}`);

    const incLog = await getJson(
      `${base}/v1/proofs/inclusion?leaf=${ep.leafHash}&root=${reportAnchor.root}&size=${reportAnchor.size}`,
    );

    const corpusIndex = corpusLeaves.indexOf(ep.leafHash);
    const inclusionProofCorpus = corpusIndex === -1 ? null : ctInclusionProof(corpusLeaves, corpusIndex);

    const consent = await getJson(
      `${base}/v1/consent/${ep.consentKey}?root=${reportAnchor.root}&size=${reportAnchor.size}`,
    );

    const claims = [];
    for (const c of ep.claims) {
      const claimInclusion = await getJson(
        `${base}/v1/proofs/inclusion?leaf=${c.leafHash}&root=${reportAnchor.root}&size=${reportAnchor.size}`,
      );
      claims.push({
        check: c.check,
        result: c.result,
        leaf: c.leafHash,
        log_index: claimInclusion.index,
        verifier_key_id: c.verifierKeyId,
        detail_hash: c.detailHash,
        detail: typeof c.detail === "string" ? JSON.parse(c.detail) : c.detail,
        inclusion_proof: claimInclusion.proof,
      });
    }

    episodeReports.push({
      leaf: ep.leafHash,
      log_index: incLog.index,
      corpus_index: corpusIndex === -1 ? null : corpusIndex,
      badges: detail.badges,
      wording: detail.wording,
      source: ep.manifest.source,
      manifest: ep.manifest,
      manifest_hash: ep.manifestHash,
      ...(ep.orgPubkey ? { org_pubkey: ep.orgPubkey } : {}),
      payload_hash: ep.manifest.payload_hash,
      preimage: detail.preimage,
      files: ep.manifest.files,
      range: ep.manifest.range ?? null,
      inclusion_proof_log: incLog.proof,
      inclusion_proof_corpus: inclusionProofCorpus,
      consent: {
        key: ep.consentKey,
        holder: consent.holder,
        status: consent.status,
        bitmap: consent.bitmap,
        siblings: consent.siblings,
        ...(consent.onset ? { onset: consent.onset } : {}),
      },
      claims,
    });
  }

  const report = {
    v: 1,
    kind: "provenance_report",
    report_id: `golden-${corpusId}-${reportAnchor.size}`,
    generated_at: Math.floor(Date.now() / 1000),
    operator: { name: operator.name, verifier_key_id: operator.keyId },
    corpus: {
      id: corpusId,
      manifest_hash: corpus.corpus_manifest_hash,
      corpus_root: corpus.corpus_root,
      episode_count: corpus.manifest.episode_count,
      terms: { hash: terms.hash, uri: terms.uri },
      contains_revoked: corpus.contains_revoked,
      on_chain: corpus.on_chain_id
        ? { chain_id: corpus.on_chain?.chain_id ?? null, registry: null, corpus_id: corpus.on_chain_id, tx: null }
        : null,
    },
    anchor: {
      root: reportAnchorRow.root, size: reportAnchorRow.size,
      revocation_root: reportAnchorRow.revocation_root, chains: reportAnchorRow.chains,
    },
    sealing_anchor: {
      root: sealingAnchorRow.root, size: sealingAnchorRow.size, chains: sealingAnchorRow.chains,
    },
    consistency_proof: consistencyProof,
    episodes: episodeReports,
    receipts: [],
    checks_run: Object.entries(
      episodeReports.flatMap((e) => e.claims).reduce((acc, c) => {
        acc[c.check] = c.detail?.check_version ? { check: c.check, check_version: c.detail.check_version, thresholds: c.detail.thresholds } : acc[c.check];
        return acc;
      }, {}),
    ).map(([, v]) => v).filter(Boolean),
    limitations,
  };

  const { hashObjectExcluding } = await import("../../packages/protocol/src/canonical.ts");
  report.report_hash = hashObjectExcluding(report, ["report_hash"]);
  return report;
}

export { l0Wording };
