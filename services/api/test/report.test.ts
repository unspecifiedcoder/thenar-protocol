/**
 * T-025 — Provenance Report: build (PLAN §9.6), render, and the shared
 * `packages/protocol/src/report-verify.ts` helper (§10.10 steps 3-7).
 *
 * Builds a small corpus (2 episodes, one claim, one revocation landing
 * *after* the corpus is sealed — §6.1's "existing sealed corpora containing
 * [a since-revoked episode]") entirely through the real production paths
 * (`commitEpisode`, `LogStore.revoke`, `appendClaim`) on an in-memory
 * `LogStore`, with anchors written directly (this store never talks to a
 * real chain — the "fake chain reader" the task names is simply this: no
 * `graspReader` is wired in, so `corpus.on_chain` is always `null`, which
 * matches `report/build.ts`'s own I-11 stance). Same plain
 * `node:assert`-free `ok()` style as the rest of `services/api/test`.
 */
import { randomBytes } from "node:crypto";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { keccak256, toBytes, toHex, type Hex } from "viem";
import { LogStore } from "../../log/src/store.ts";
import type { ILogStore } from "../../log/src/store-interface.ts";
import { ApiError } from "../src/errors.ts";
import { buildReport, LIMITATIONS } from "../src/report/build.ts";
import { renderReportHtml } from "../src/report/render.ts";
import { UnavailablePdfRenderer, PdfUnavailableError } from "../src/report/pdf.ts";
import { commitEpisode } from "../src/ingest/commit.ts";
import type { OperatorSigner } from "../src/ingest/receipt.ts";
import { appendClaim } from "../../verify/src/issue.ts";
import { newConsentRecord, recordHash, consentKey as deriveConsentKey, consentCommitment } from "../../../packages/protocol/src/consent.ts";
import { sign as signObject, verify as verifySignature, keyId as deriveKeyId } from "../../../packages/protocol/src/sign.ts";
import { payloadHash, type FileEntry } from "../../../packages/protocol/src/payload.ts";
import { hashObjectExcluding, type JsonObject } from "../../../packages/protocol/src/canonical.ts";
import { SparseTree } from "../../../packages/protocol/src/sparse.ts";
import { verifyReport } from "../../../packages/protocol/src/report-verify.ts";
import * as webVerify from "../../../apps/web/verify.js";

ed.hashes.sha512 = sha512;

let fails = 0;
const ok = (c: boolean, m: string, x = ""): void => {
  if (!c) fails++;
  console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`);
};

const NOW = 1_770_000_000;
const TERMS_HASH = keccak256(toHex("report-test terms")) as Hex;
const ORG = "org_report_test";

async function makeKeyPair() {
  const sk = ed.utils.randomSecretKey();
  const pub = await ed.getPublicKeyAsync(sk);
  return { sk: toHex(sk), pub: toHex(pub), keyId: deriveKeyId(toHex(pub)) };
}

async function makeSigner(): Promise<OperatorSigner> {
  const kp = await makeKeyPair();
  return { keyId: kp.keyId, privateKey: kp.sk };
}

type BuiltEpisode = { leafHash: Hex; leafIndex: number; consentKeyHex: Hex; record: ReturnType<typeof newConsentRecord>; holderPriv: Hex };

async function buildEpisode(store: ILogStore, operator: OperatorSigner, orgId: string, idx: number, source: "sim" | "teleop_real"): Promise<BuiltEpisode> {
  const holder = await makeKeyPair();
  const record = newConsentRecord({ holder: "organisation", pubkey: holder.pub, alg: "ed25519", scope_bits: 1, terms_hash: TERMS_HASH, granted_at: NOW });
  const rHash = recordHash(record);
  const consentKeyHex = deriveConsentKey(rHash);
  const salt = toHex(randomBytes(32));
  const commitment = consentCommitment(rHash, salt);

  const files: FileEntry[] = [
    { path: `data/chunk-000/ep${idx}.parquet`, bytes: 1024, hash: keccak256(toHex(`data-${idx}`)) },
    { path: `videos/observation.images.front/chunk-000/ep${idx}.mp4`, bytes: 8192, hash: keccak256(toHex(`video-${idx}`)) },
  ];
  const pHash = payloadHash(files);

  const manifest = {
    v: 1 as const, kind: "capture_manifest" as const, org_id: orgId, dataset_id: null,
    source, layout: "per_episode" as const, embodiment: "so_arm100",
    rate_hz: 30, duration_ms: 1000, captured_at: NOW,
    channels: [{ name: "observation.images.front", dtype: "video/mp4", shape: [480, 640, 3], hz: 30 }],
    files, range: null,
    payload_hash: pHash, consent_commitment: commitment, terms_hash: TERMS_HASH, scope_bits: 1,
    task: null, outcome: null, sim: null, signature: null,
  };

  const out = await commitEpisode({ store, now: () => NOW, operator }, orgId, manifest, null, consentKeyHex);
  return { leafHash: out.leafHash, leafIndex: out.leafIndex, consentKeyHex, record, holderPriv: holder.sk };
}

function currentRevocationRoot(store: ILogStore): Hex {
  const smt = new SparseTree();
  for (const r of store.revocations()) smt.set(r.consentKey, r.value);
  return smt.root();
}

function anchorNow(store: ILogStore, chainId = 43113, blockNumber = 9000): void {
  const idx = store.anchors().length;
  const size = store.size();
  const root = store.root(size);
  const revocationRoot = currentRevocationRoot(store);
  const tx = ("0x" + "ab".repeat(32)) as Hex;
  store.recordAnchor(idx, root, size, revocationRoot, tx, blockNumber + idx);
  store.recordAnchorChain(chainId, idx, root, size, revocationRoot, tx, blockNumber + idx);
}

async function run() {
  const store = new LogStore(":memory:");
  const operator = await makeSigner();
  const verifier = await makeSigner();

  // ---- two episodes, both live -------------------------------------------
  const ep1 = await buildEpisode(store, operator, ORG, 1, "sim");
  const ep2 = await buildEpisode(store, operator, ORG, 2, "teleop_real");
  anchorNow(store); // A0: size 2, revocationRoot = empty tree

  // ---- corpus: draft, then logged (before any revocation) ----------------
  const { corpusRootOf, corpusManifestHash: computeCorpusManifestHash } = await import("../../../packages/protocol/src/mapping.ts");
  const { encodeCorpus, corpusLeafHash } = await import("../../../packages/protocol/src/corpus.ts");

  const entries = [{ leaf: ep1.leafHash, logIndex: ep1.leafIndex }, { leaf: ep2.leafHash, logIndex: ep2.leafIndex }];
  const corpusRoot = corpusRootOf(entries);
  const draftManifest = {
    v: 1 as const, kind: "corpus_manifest" as const, org_id: ORG, title: "report-test corpus",
    episodes: [ep1.leafHash, ep2.leafHash], corpus_root: corpusRoot, episode_count: 2,
    terms_hash: TERMS_HASH, task_id: null, sources: ["sim", "teleop_real"] as const,
    filters: {}, sealed_at: null,
  };
  const draftHash = computeCorpusManifestHash(draftManifest as any);
  const corpusId = "corpus_report_test";
  store.insertCorpus(
    { corpusId, orgId: ORG, manifest: JSON.stringify(draftManifest), corpusManifestHash: draftHash, corpusRoot,
      manifestLeafHash: null, manifestLeafIdx: null, onChainId: null, status: "draft", containsRevoked: false, createdAt: NOW },
    [{ leafHash: ep1.leafHash, corpusIndex: 0 }, { leafHash: ep2.leafHash, corpusIndex: 1 }],
  );

  // ---- draft report: unsealed corpus -> draft:true ------------------------
  const draftReport = buildReport({ logStore: store, operator: { name: "THENAR", verifierKeyId: verifier.keyId } }, corpusId);
  ok(draftReport.corpus.draft === true, "draft corpus report: corpus.draft is true");
  ok(draftReport.sealing_anchor === null, "draft corpus report: sealing_anchor is null");
  ok(Array.isArray(draftReport.consistency_proof) && draftReport.consistency_proof.length === 0, "draft corpus report: consistency_proof is empty");
  ok(draftReport.episodes.length === 2, "draft corpus report: has both episodes");

  // ---- log the corpus (0x03 leaf) -----------------------------------------
  const sealedAt = NOW + 10;
  const sealedManifest = { ...draftManifest, sealed_at: sealedAt };
  const sealedHash = computeCorpusManifestHash(sealedManifest as any);
  const preimage03 = encodeCorpus({
    corpusManifestHash: sealedHash, corpusRoot, termsHash: TERMS_HASH,
    taskId: ("0x" + "00".repeat(32)) as Hex, episodeCount: 2n, sealedAt: BigInt(sealedAt),
  });
  const manifestLeafHash = corpusLeafHash(preimage03);
  const manifestLeafIdx = store.append(manifestLeafHash, { preimage: preimage03 });
  store.setCorpusManifestLeaf(corpusId, manifestLeafHash, manifestLeafIdx, "logged", JSON.stringify(sealedManifest), sealedHash);

  anchorNow(store); // A1: size 3 (covers the corpus leaf) — this is the sealing anchor

  // ---- a claim on ep1 -------------------------------------------------------
  const claimUnsigned = {
    v: 1 as const, kind: "verification_claim" as const, subject_leaf: ep1.leafHash, verifier_key_id: verifier.keyId,
    check: "dedup.v1" as const, result: "pass" as const, level_asserted: 3,
    detail: { check_version: "dedup.v1-report-test", thresholds: { rho_min: 0.98 } }, issued_at: NOW + 20,
  };
  const claimObjectHash = hashObjectExcluding(claimUnsigned as unknown as JsonObject, ["signature"]);
  const claimSig = await signObject("ed25519", "claim", claimObjectHash, verifier.privateKey);
  await appendClaim(store, { ...claimUnsigned, signature: { alg: "ed25519", key_id: verifier.keyId, sig: claimSig } } as any);

  // `config/checks.json` marks timing.v1/kinematics.v1 `blocking: true` —
  // L3 needs every blocking check to have a passing claim (`badges.ts`),
  // so ep1 needs those two as well as dedup.v1 to actually earn L3.
  for (const check of ["timing.v1", "kinematics.v1"] as const) {
    const unsigned = {
      v: 1 as const, kind: "verification_claim" as const, subject_leaf: ep1.leafHash, verifier_key_id: verifier.keyId,
      check, result: "pass" as const, level_asserted: 3,
      detail: { check_version: `${check}-report-test`, thresholds: {} }, issued_at: NOW + 21,
    };
    const objHash = hashObjectExcluding(unsigned as unknown as JsonObject, ["signature"]);
    const sig = await signObject("ed25519", "claim", objHash, verifier.privateKey);
    await appendClaim(store, { ...unsigned, signature: { alg: "ed25519", key_id: verifier.keyId, sig } } as any);
  }

  // ---- revoke ep2 *after* the corpus was sealed (§6.1) ---------------------
  const revokeSig = await signObject("ed25519", "revoke", ep2.consentKeyHex, ep2.holderPriv);
  const revokeVerifies = await verifySignature("ed25519", "revoke", ep2.consentKeyHex, revokeSig, ep2.record.pubkey);
  ok(revokeVerifies, "sanity: revoke signature verifies before being submitted");
  await store.revoke(ep2.record, revokeSig);

  const finalSize = store.size();
  anchorNow(store); // A2: covers every claim leaf too, revocationRoot now includes ep2 — the report anchor

  // ---- build the real (logged, sealed) report ------------------------------
  const report = buildReport({ logStore: store, operator: { name: "THENAR", verifierKeyId: verifier.keyId } }, corpusId);

  ok(report.v === 1 && report.kind === "provenance_report", "report: v/kind");
  ok(typeof report.report_id === "string" && report.report_id.length > 0, "report: report_id present");
  ok(report.generated_at > 0, "report: generated_at present");
  ok(report.operator.name === "THENAR" && report.operator.verifier_key_id === verifier.keyId, "report: operator block");
  ok(report.corpus.id === corpusId, "report: corpus.id");
  ok(report.corpus.manifest_hash === sealedHash, "report: corpus.manifest_hash matches the sealed manifest");
  ok(report.corpus.corpus_root === corpusRoot, "report: corpus.corpus_root");
  ok(report.corpus.episode_count === 2, "report: corpus.episode_count");
  ok(report.corpus.terms.hash === TERMS_HASH, "report: corpus.terms.hash");
  ok(report.corpus.contains_revoked === true, "report: contains_revoked is true (ep2 revoked after sealing)");
  ok(report.corpus.on_chain === null, "report: on_chain is null (no on-chain sealing recorded)");
  ok(report.corpus.draft === false, "report: corpus.draft is false once logged");
  ok(!!report.anchor && report.anchor.size === finalSize, "report: anchor is the head anchor", `${report.anchor?.size} vs ${finalSize}`);
  ok(!!report.sealing_anchor && report.sealing_anchor.size === 3, "report: sealing_anchor is the anchor that first covered the corpus leaf (size 3)");
  ok(report.consistency_proof.length > 0, "report: non-empty consistency_proof (sealing size 3 -> report anchor)");
  ok(report.episodes.length === 2, "report: two episodes");
  ok(Array.isArray(report.receipts) && report.receipts.length === 0, "report: receipts empty (nothing sealed on chain)");
  ok(report.checks_run.length === 3 && report.checks_run.some((r) => r.check === "dedup.v1"), "report: checks_run lists every check run");
  ok(JSON.stringify(report.limitations) === JSON.stringify(LIMITATIONS), "report: limitations is exactly LIMITATIONS");

  const [rep1, rep2] = report.episodes;
  ok(rep1.leaf === ep1.leafHash && rep2.leaf === ep2.leafHash, "report: episodes in log-index order");
  ok(rep1.badges.includes("L0") && rep1.badges.includes("L3"), "report: ep1 has L0+L3 (dedup.v1 pass)");
  ok(rep1.consent.status === "live", "report: ep1 consent live");
  ok(rep2.consent.status === "revoked", "report: ep2 consent revoked");
  ok(!!rep2.consent.onset && typeof rep2.consent.onset.block === "number", "report: ep2 consent carries an onset block");
  ok((rep2.consent as any).value !== undefined, "report: ep2 consent carries the revocation value");
  ok(rep1.claims.length === 3 && rep1.claims.some((c) => c.check === "dedup.v1" && c.result === "pass"), "report: ep1 carries the dedup.v1 claim");
  ok(rep1.source === "sim" && rep2.source === "teleop_real", "report: per-episode declared source");
  ok(rep1.wording.some((w) => w.startsWith("Source — declared")), "report: ep1 wording includes the source line");
  ok(rep1.files.length === 2 && rep1.files[0].path.includes("ep1"), "report: ep1 files carried through");

  // ---- forbidden-words / wording guard (T-021) -----------------------------
  const FORBIDDEN = ["authentic", "genuine", "real", "proven real", "verified", "independent"];
  const allWording = report.episodes.flatMap((e) => e.wording).join(" ").toLowerCase();
  for (const w of FORBIDDEN) {
    // "Checked by ... Heuristic; see details." legitimately contains none of
    // these; "real" appears inside "teleop_real"/"autonomous_real" source
    // *values*, not in rendered wording text, so a plain substring check on
    // the rendered lines is the right level for this guard.
    ok(!allWording.includes(w), `report wording contains no forbidden word "${w}"`);
  }

  // ---- report_hash recomputes ------------------------------------------------
  const recomputedHash = hashObjectExcluding(report as unknown as JsonObject, ["report_hash"]);
  ok(recomputedHash === report.report_hash, "report: report_hash recomputes");

  // ---- packages/protocol/src/report-verify.ts (PLAN §10.10 steps 3-7) -------
  const verifyResult = verifyReport(report as any);
  ok(verifyResult.allPassed, "report-verify.ts: every step passes", verifyResult.steps.filter((s) => !s.ok && !s.notChecked).map((s) => `${s.name}: ${s.detail}`).join("; "));
  ok(verifyResult.reportHashOk === true, "report-verify.ts: report_hash step passes");

  // cross-check against apps/web/verify.js's own independent implementation
  const webResult = (webVerify as any).verifyReport(report);
  ok(webResult.allPassed, "apps/web/verify.js verifyReport: passes on the same generated report",
    webResult.steps.filter((s: any) => !s.ok && !s.notChecked).map((s: any) => `${s.name}: ${s.detail}`).join("; "));
  ok(webResult.reportHashOk === true, "apps/web/verify.js verifyReport: report_hash matches");

  // ---- I-11: a mutated proof makes build() throw -----------------------------
  const tamperedStore = Object.create(store) as ILogStore;
  const realInclusionProof = store.inclusionProof.bind(store);
  (tamperedStore as any).inclusionProof = (index: number, size?: number) => {
    const real = realInclusionProof(index, size);
    if (real.length === 0) return real;
    return [("0x" + "ff".repeat(32)) as Hex, ...real.slice(1)];
  };
  let threwOnTamper = false;
  try {
    buildReport({ logStore: tamperedStore, operator: { name: "THENAR", verifierKeyId: verifier.keyId } }, corpusId);
  } catch (e) {
    threwOnTamper = e instanceof ApiError;
  }
  ok(threwOnTamper, "buildReport throws (ApiError) when a log inclusion proof does not verify (I-11)");

  // ---- render.ts: HTML template rendering ------------------------------------
  const html = renderReportHtml(report, { reportJsonUrl: "https://example.test/v1/corpora/corpus_report_test/report" });
  ok(html.includes("<!doctype html>"), "render: emits an HTML document");
  ok(html.includes(report.report_id), "render: includes the report id");
  ok(html.includes(report.corpus.corpus_root), "render: includes corpus_root");
  ok(html.includes(report.report_hash), "render: includes report_hash");
  ok(!html.includes("{{"), "render: no unreplaced template placeholders remain");
  for (const l of LIMITATIONS) {
    ok(html.includes(escapeForCheck(l)), "render: limitations text present verbatim", l.slice(0, 30));
  }

  // ---- pdf.ts: PdfRenderer interface / 503 path ------------------------------
  const unavailable = new UnavailablePdfRenderer();
  let pdfThrew = false;
  try {
    await unavailable.renderPdf();
  } catch (e) {
    pdfThrew = e instanceof PdfUnavailableError;
  }
  ok(pdfThrew, "UnavailablePdfRenderer.renderPdf throws PdfUnavailableError");

  console.log(fails === 0 ? "\nreport.test.ts: all ok" : `\nreport.test.ts: ${fails} FAILURES`);
  if (fails > 0) process.exit(1);
}

/** Matches the HTML-escaping `render.ts` applies (no special chars in our limitations text besides plain ASCII, so this is effectively identity — kept explicit for clarity). */
function escapeForCheck(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

run();
