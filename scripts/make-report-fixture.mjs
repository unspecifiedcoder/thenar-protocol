#!/usr/bin/env node
/**
 * make-report-fixture.mjs — T-026 supervisor adjustment (2).
 *
 * T-025 (the real report generator) does not exist yet, so `/verify`'s
 * report-mode tests need a hand-assembled fixture whose proofs are real —
 * genuinely computed with the TS protocol library (`packages/protocol/src`),
 * not invented (PLAN I-11). This script builds one small self-consistent
 * log (two episodes, a corpus manifest leaf, one claim leaf), a consent
 * sparse tree with one live and one revoked record, and writes the result
 * as `apps/web/samples/report-fixture.json` in the normative Report v1
 * shape (PLAN §9.6).
 *
 * Run with `npx tsx scripts/make-report-fixture.mjs` (it imports the TS
 * protocol sources directly). Not part of any test run; re-run by hand
 * whenever the fixture needs to change, and re-check in the regenerated
 * file.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { keccak256, concatHex, toHex } from "viem";

import { hashObject, hashObjectExcluding } from "../packages/protocol/src/canonical.ts";
import { root as ctRoot, inclusionProof, consistencyProof } from "../packages/protocol/src/log.ts";
import { SparseTree, computeRoot as smtComputeRoot } from "../packages/protocol/src/sparse.ts";
import { encodeEpisode, hashEpisodeLeaf } from "../packages/protocol/src/episode.ts";
import { encodeCorpus, corpusLeafHash } from "../packages/protocol/src/corpus.ts";
import { encodeClaim, claimLeafHash } from "../packages/protocol/src/claim.ts";
import { manifestHash as manifestHashOf, corpusManifestHash as corpusManifestHashOf, manifestToEpisode, corpusRootOf } from "../packages/protocol/src/mapping.ts";
import { newConsentRecord, recordHash, consentKey, consentCommitment, revocationValue } from "../packages/protocol/src/consent.ts";
import { commitConsent } from "../packages/protocol/src/leaf.ts";
import { sign, keyId, message } from "../packages/protocol/src/sign.ts";
import { l0Wording, l1Wording, l3Wording } from "../packages/protocol/src/wording.ts";
import * as ed from "@noble/ed25519";

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(here, "../apps/web/samples/report-fixture.json");

const fileHash = (bytes) => keccak256(bytes);
const utf8 = (s) => toHex(s);

async function main() {
  // ---- test-only keys (deterministic seeds, never used in production) ----
  const orgSecret = "0x" + "11".repeat(32); // TEST-ONLY key — deterministic, never used in production
  const orgPub = toHex(ed.getPublicKey(hexToBytes(orgSecret)));
  const orgKeyId = keyId(orgPub);

  const holderSecret = "0x" + "22".repeat(32); // TEST-ONLY key — deterministic, never used in production
  const holderPub = toHex(ed.getPublicKey(hexToBytes(holderSecret)));

  const verifierSecret = "0x" + "33".repeat(32); // TEST-ONLY key — deterministic, never used in production
  const verifierPub = toHex(ed.getPublicKey(hexToBytes(verifierSecret)));
  const verifierKeyId = keyId(verifierPub);

  const termsHash = keccak256(utf8("THENAR fixture terms v1"));

  // ---- two episodes' file sets and payloadHash (PLAN §10.4) ----
  function episodePayload(tag) {
    const files = [
      { path: `data/chunk-000/${tag}.parquet`, bytes: 1024, hash: fileHash(utf8(`${tag}-data`)) },
      { path: `videos/observation.images.front/chunk-000/${tag}.mp4`, bytes: 8192, hash: fileHash(utf8(`${tag}-video`)) },
    ];
    const leaves = files.map((f) => keccak256(concatHex(["0x00", toHex(f.path), "0x1f", f.hash])));
    const payloadHash = ctRoot(leaves);
    return { files, payloadHash };
  }

  const p1 = episodePayload("ep1");
  const p2 = episodePayload("ep2");

  // ---- consent: episode 1 stays live, episode 2 is revoked ----
  function buildConsent(scopeBits) {
    const record = newConsentRecord({
      holder: "contributor",
      pubkey: holderPub,
      alg: "ed25519",
      scope_bits: scopeBits,
      terms_hash: termsHash,
    });
    const rHash = recordHash(record);
    const key = consentKey(rHash);
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const commitment = commitConsent(rHash, toHex(salt));
    return { record, recordHash: rHash, key, commitment };
  }
  const consent1 = buildConsent(11);
  const consent2 = buildConsent(11);

  const smt = new SparseTree();
  smt.set(consent2.key, revocationValue(consent2.recordHash)); // episode 2 revoked; episode 1 stays absent (live)

  const capturedAt = 1756900000n;
  const submittedAt1 = 1756900060n;
  const submittedAt2 = 1756900070n;

  // ---- capture manifests (§9.1) — enough fields for manifestHash/mapping ----
  function buildManifest(tag, consent, submittedAt, capturedAt, taskInstr) {
    const m = {
      v: 1,
      kind: "capture_manifest",
      org_id: "01JFIXTUREORG00000000000",
      dataset_id: null,
      source: "sim",
      layout: "per_episode",
      embodiment: "so_arm100",
      rate_hz: 30,
      duration_ms: 12400,
      captured_at: Number(capturedAt),
      channels: [
        { name: "action", dtype: "float32", shape: [6], hz: 30 },
        { name: "observation.state", dtype: "float32", shape: [6], hz: 30 },
      ],
      files: (tag === "ep1" ? p1 : p2).files.map((f) => ({ path: f.path, bytes: f.bytes, hash: f.hash })),
      range: null,
      payload_hash: (tag === "ep1" ? p1 : p2).payloadHash,
      consent_commitment: consent.commitment,
      terms_hash: termsHash,
      scope_bits: 11,
      task: { instruction: taskInstr, task_id: null },
      outcome: { success: true },
      sim: { task_spec_hash: keccak256(utf8("fixture-task-spec")), world_seed: "12345" },
      signature: null,
    };
    const mh = manifestHashOf(m);
    return { manifest: m, manifestHash: mh };
  }

  const cm1 = buildManifest("ep1", consent1, submittedAt1, capturedAt, "fold the towel");
  const cm2 = buildManifest("ep2", consent2, submittedAt2, capturedAt, "stack the cups");

  const episode1 = manifestToEpisode(cm1.manifest, submittedAt1);
  const episode2 = manifestToEpisode(cm2.manifest, submittedAt2);
  const preimage1 = encodeEpisode(episode1);
  const preimage2 = encodeEpisode(episode2);
  const leaf1 = hashEpisodeLeaf(preimage1);
  const leaf2 = hashEpisodeLeaf(preimage2);

  // ---- corpus over both episodes (§10.7) ----
  const corpusRoot = corpusRootOf([{ leaf: leaf1, logIndex: 0 }, { leaf: leaf2, logIndex: 1 }]);
  const corpusManifest = {
    v: 1,
    kind: "corpus_manifest",
    org_id: "01JFIXTUREORG00000000000",
    title: "THENAR verify-page fixture corpus",
    episodes: [leaf1, leaf2],
    corpus_root: corpusRoot,
    episode_count: 2,
    terms_hash: termsHash,
    task_id: null,
    filters: { min_badges: ["L0"], exclude_failed_checks: true },
    sealed_at: 1756900500,
  };
  const cmh = corpusManifestHashOf(corpusManifest);
  const corpusPreimage = encodeCorpus({
    corpusManifestHash: cmh,
    corpusRoot,
    termsHash,
    taskId: ("0x" + "00".repeat(32)),
    episodeCount: 2n,
    sealedAt: 1756900500n,
  });
  const corpusLeaf = corpusLeafHash(corpusPreimage);

  // ---- one claim: dedup.v1 pass on episode 1 (§9.3, §10.3 0x04) ----
  const detail = { check_version: "dedup.v1-fixture", thresholds: { rho_min: 0.98 }, index_snapshot: "fixture" };
  const detailHash = hashObject(detail);
  const claimIssuedAt = 1756900400n;
  const claimUnsigned = {
    v: 1, kind: "verification_claim",
    subject_leaf: leaf1, verifier_key_id: verifierKeyId,
    check: "dedup.v1", result: "pass", level_asserted: 3,
    detail, issued_at: Number(claimIssuedAt),
  };
  const claimObjHash = hashObjectExcluding(claimUnsigned, ["signature"]);
  const claimSig = await sign("ed25519", "claim", claimObjHash, verifierSecret);
  const sigHash = keccak256(claimSig);
  const claimPreimage = encodeClaim({
    subjectLeaf: leaf1, verifierKeyId, detailHash, signatureHash: sigHash,
    checkId: 1, result: 1, levelAsserted: 3, issuedAt: claimIssuedAt,
  });
  const claimLeaf = claimLeafHash(claimPreimage);

  // ---- the log: leaf0=episode1, leaf1=episode2, leaf2=corpus, leaf3=claim ----
  const allLeaves = [leaf1, leaf2, corpusLeaf, claimLeaf];
  const sealingSize = 3; // sealed before the claim was logged (edge case: report is ahead)
  const reportSize = 4;
  const sealingRoot = ctRoot(allLeaves.slice(0, sealingSize));
  const reportRoot = ctRoot(allLeaves.slice(0, reportSize));
  const consistencyProofOut = consistencyProof(allLeaves, sealingSize, reportSize);

  const inclusionLog1 = inclusionProof(allLeaves.slice(0, reportSize), 0);
  const inclusionLog2 = inclusionProof(allLeaves.slice(0, reportSize), 1);
  const inclusionCorpus1 = inclusionProof([leaf1, leaf2], 0);
  const inclusionCorpus2 = inclusionProof([leaf1, leaf2], 1);
  const inclusionClaim = inclusionProof(allLeaves.slice(0, reportSize), 3);

  // ---- consent proofs at the report anchor ----
  const proof1 = smt.proof(consent1.key); // absent -> live
  const proof2 = smt.proof(consent2.key); // present -> revoked
  const revocationRoot = smt.root();

  // sanity: local recompute must match what the tree produced
  const check1 = smtComputeRoot(consent1.key, ("0x" + "00".repeat(32)), proof1.bitmap, proof1.siblings);
  const check2 = smtComputeRoot(consent2.key, revocationValue(consent2.recordHash), proof2.bitmap, proof2.siblings);
  if (check1 !== revocationRoot) throw new Error("consent1 local recompute mismatch");
  if (check2 !== revocationRoot) throw new Error("consent2 local recompute mismatch");

  const anchorBlock = 9001;
  const chainEntry = (index, block) => ({ chain_id: 31337, index, block_number: block, at: 1756900600, tx: "0x" + "ab".repeat(32) });

  const badges1 = ["L0", "L3"];
  const badges2 = ["L0"];

  const report = {
    v: 1,
    kind: "provenance_report",
    report_id: "01JFIXTUREREPORT0000000",
    generated_at: 1756900700,
    operator: { name: "THENAR fixtures", verifier_key_id: orgKeyId },
    corpus: {
      id: "01JFIXTURECORPUS0000000",
      manifest_hash: cmh,
      corpus_root: corpusRoot,
      episode_count: 2,
      terms: { hash: termsHash, uri: "https://thenar.io/terms/fixture" },
      contains_revoked: true,
      on_chain: null,
    },
    anchor: {
      root: reportRoot, size: reportSize, revocation_root: revocationRoot,
      chains: [chainEntry(2, anchorBlock)],
    },
    sealing_anchor: {
      root: sealingRoot, size: sealingSize,
      chains: [chainEntry(1, anchorBlock - 50)],
    },
    consistency_proof: consistencyProofOut,
    episodes: [
      {
        leaf: leaf1, log_index: 0, corpus_index: 0, badges: badges1,
        wording: [
          l0Wording(String(anchorBlock), "Avalanche Fuji", "live", String(reportSize)),
          l3Wording("THENAR", 1, "dedup.v1"),
        ],
        source: cm1.manifest.source,
        manifest_hash: cm1.manifestHash, payload_hash: p1.payloadHash, preimage: preimage1,
        files: p1.files, range: null,
        inclusion_proof_log: inclusionLog1, inclusion_proof_corpus: inclusionCorpus1,
        consent: { key: consent1.key, holder: "contributor", status: "live", bitmap: proof1.bitmap.toString(), siblings: proof1.siblings },
        claims: [{ check: "dedup.v1", result: "pass", leaf: claimLeaf, log_index: 3, verifier_key_id: verifierKeyId, detail_hash: detailHash, detail }],
      },
      {
        leaf: leaf2, log_index: 1, corpus_index: 1, badges: badges2,
        wording: [
          l0Wording(String(anchorBlock), "Avalanche Fuji", { revoked_at_block: String(anchorBlock - 10) }, String(reportSize)),
        ],
        source: cm2.manifest.source,
        manifest_hash: cm2.manifestHash, payload_hash: p2.payloadHash, preimage: preimage2,
        files: p2.files, range: null,
        inclusion_proof_log: inclusionLog2, inclusion_proof_corpus: inclusionCorpus2,
        consent: { key: consent2.key, holder: "contributor", status: "revoked", value: revocationValue(consent2.recordHash), bitmap: proof2.bitmap.toString(), siblings: proof2.siblings, onset: { block: anchorBlock - 10 } },
        claims: [],
      },
    ],
    receipts: [],
    checks_run: [{ check: "dedup.v1", check_version: "dedup.v1-fixture", thresholds: { rho_min: 0.98 } }],
    limitations: [
      "The operator (THENAR) can decline to log or anchor a record; append receipts and public audit make this detectable, not impossible.",
      "Checks are heuristics with recorded thresholds; they can be evaded and can err; they are evidence, not proof.",
      "A signature proves which key signed, not what a sensor measured; captured_at, source and embodiment are claims by the signer.",
      "Consent onset is recorded; what a buyer may do after onset is governed by the terms document, not by this protocol.",
      "Anchors depend on the availability of at least one chain carrying the log; the same log is anchored on more than one.",
    ],
  };
  report.report_hash = hashObjectExcluding(report, ["report_hash"]);

  writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
  console.log(`wrote ${OUT}`);
}

function hexToBytes(hex) {
  const s = hex.replace(/^0x/, "");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

main().catch((e) => { console.error(e); process.exit(1); });
