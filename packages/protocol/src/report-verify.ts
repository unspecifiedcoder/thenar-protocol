/**
 * T-025 — shared report verifier (PLAN §10.10 steps 3-7).
 *
 * A pure-TS port of `apps/web/merkle.js`'s inclusion/consistency fold plus
 * `apps/web/verify.js`'s report-mode steps, so `services/api/test/
 * report.test.ts`, T-033's CLI and (eventually) `apps/web/verify.js` share
 * one implementation instead of three copies drifting apart. No I/O: takes
 * a Report v1 JSON object (PLAN §9.6) and returns which of §10.10's
 * checkable-without-files steps passed. Steps 1-2 (delivered file hashes,
 * manifest signature) need the delivered bundle bytes/manifest object,
 * which a Report does not embed (§9.6 carries only `manifest_hash`), so
 * they are out of scope here — a caller with the files runs those
 * separately (`scripts/verify-report.mjs`, T-033).
 */
import { hashNode as ctHashNode } from "./log";
import { computeRoot as smtComputeRoot, ZERO as SMT_ZERO } from "./sparse";
import { hashObject, hashObjectExcluding, type JsonObject } from "./canonical";
import type { Hex } from "viem";

/** Largest power of two strictly less than n (mirrors `log.ts`'s `split`). */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/**
 * Verify an inclusion proof for `leaf` at `index` in a tree of size `size`
 * against `expectedRoot`, folding siblings without rebuilding the tree
 * (PLAN §10.1) — a report verifier never has every leaf, only the proof.
 */
export function verifyInclusion(leaf: Hex, index: number, size: number, proof: Hex[], expectedRoot: Hex): boolean {
  if (size < 1) return false;
  if (index < 0 || index >= size) return false;
  const folded = fold(leaf, index, size, proof);
  if (folded === null) return false;
  return folded.node === expectedRoot && folded.used === proof.length;
}

function fold(leaf: Hex, index: number, size: number, proof: Hex[]): { node: Hex; used: number } | null {
  function go(idx: number, n: number): { node: Hex; used: number } | null {
    if (n === 1) return { node: leaf, used: 0 };
    const k = split(n);
    if (idx < k) {
      const left = go(idx, k);
      if (left === null) return null;
      if (left.used >= proof.length) return null;
      return { node: ctHashNode(left.node, proof[left.used]), used: left.used + 1 };
    }
    const right = go(idx - k, n - k);
    if (right === null) return null;
    if (right.used >= proof.length) return null;
    return { node: ctHashNode(proof[right.used], right.node), used: right.used + 1 };
  }
  return go(index, size);
}

/**
 * Verify a consistency proof: the tree of size `m` (root `rootM`) is a
 * prefix of the tree of size `n` (root `rootN`) — RFC 6962 §2.1.2's
 * standard bit-decomposition verifier algorithm, ported from
 * `apps/web/merkle.js` (cross-checked there against `log.ts` for every
 * (m, n) pair with 1 <= m <= n <= 64 in `apps/web/test/verify.test.mjs`).
 */
export function verifyConsistency(m: number, n: number, proof: Hex[], rootM: Hex, rootN: Hex): boolean {
  if (m < 1 || m > n) return false;
  if (m === n) return proof.length === 0 && rootM === rootN;
  if (proof.length === 0) return false;

  let fn = BigInt(m - 1);
  let sn = BigInt(n - 1);
  while (fn % 2n === 1n) {
    fn >>= 1n;
    sn >>= 1n;
  }

  let p = proof.slice();
  let node1: Hex;
  let node2: Hex;
  if (fn > 0n) {
    node1 = p[0];
    node2 = p[0];
    p = p.slice(1);
  } else {
    node1 = rootM;
    node2 = rootM;
  }

  while (p.length > 0) {
    if (sn === 0n) return false; // proof too long
    if (fn % 2n === 1n || fn === sn) {
      node1 = ctHashNode(p[0], node1);
      node2 = ctHashNode(p[0], node2);
      while (fn % 2n === 0n && fn !== 0n) {
        fn >>= 1n;
        sn >>= 1n;
      }
    } else {
      node2 = ctHashNode(node2, p[0]);
    }
    fn >>= 1n;
    sn >>= 1n;
    p = p.slice(1);
  }
  if (sn !== 0n) return false; // proof too short
  return node1 === rootM && node2 === rootN;
}

export type ReportStep = { name: string; ok: boolean; detail: string; notChecked?: boolean };

/** Anything shaped enough like a Report v1 (PLAN §9.6) to walk — kept loose (not the full zod schema) so a caller building one incrementally can still be checked. */
export type ReportLike = {
  report_hash?: Hex;
  anchor?: { root: Hex; size: number; revocation_root?: Hex; chains?: unknown[] };
  sealing_anchor?: { root: Hex; size: number } | null;
  consistency_proof?: Hex[];
  corpus?: { corpus_root?: Hex; episode_count?: number };
  episodes?: Array<{
    leaf: Hex;
    log_index: number;
    corpus_index?: number;
    manifest_hash?: Hex;
    inclusion_proof_log: Hex[];
    inclusion_proof_corpus?: Hex[];
    consent?: {
      key: Hex;
      status: "live" | "revoked";
      value?: Hex;
      bitmap: string;
      siblings: Hex[];
      onset?: { block: number };
    };
    claims?: Array<{
      check: string;
      leaf?: Hex;
      log_index?: number;
      result: string;
      detail_hash: Hex;
      detail: JsonObject;
    }>;
  }>;
  [k: string]: unknown;
};

function stepInclusion(ep: NonNullable<ReportLike["episodes"]>[number], anchor: NonNullable<ReportLike["anchor"]>): ReportStep {
  const ok = verifyInclusion(ep.leaf, ep.log_index, anchor.size, ep.inclusion_proof_log, anchor.root);
  return {
    name: "log inclusion", ok,
    detail: ok ? `leaf ${ep.leaf} included at index ${ep.log_index}` : "inclusion proof does not fold to the report anchor root",
  };
}

function stepConsistency(report: ReportLike): ReportStep {
  const { sealing_anchor: sealingAnchor, anchor, consistency_proof: consistencyProof } = report;
  if (!sealingAnchor || !anchor) {
    return { name: "consistency (sealing → report anchor)", ok: false, detail: "report is missing sealing_anchor or anchor" };
  }
  if (sealingAnchor.size === anchor.size) {
    const ok = sealingAnchor.root === anchor.root && (consistencyProof || []).length === 0;
    return {
      name: "consistency (sealing → report anchor)", ok,
      detail: ok ? "sealing and report anchors are the same size and root" : "same size but roots differ, or a non-empty proof was given for equal sizes",
    };
  }
  const ok = verifyConsistency(sealingAnchor.size, anchor.size, consistencyProof || [], sealingAnchor.root, anchor.root);
  return {
    name: "consistency (sealing → report anchor)", ok,
    detail: ok
      ? `size ${sealingAnchor.size} → ${anchor.size} is a valid extension`
      : "consistency proof does not connect the sealing anchor to the report anchor",
  };
}

function stepConsent(ep: NonNullable<ReportLike["episodes"]>[number], anchor: NonNullable<ReportLike["anchor"]>): ReportStep {
  const consent = ep.consent;
  if (!consent) return { name: "consent", ok: false, detail: "no consent block in this episode" };
  if (!anchor.revocation_root) return { name: "consent", ok: false, detail: "report anchor carries no revocation_root" };
  try {
    const bitmap = BigInt(consent.bitmap);
    const siblings = consent.siblings || [];
    if (consent.status === "live") {
      const got = smtComputeRoot(consent.key, SMT_ZERO, bitmap, siblings);
      const ok = got === anchor.revocation_root;
      return {
        name: "consent (non-membership → live)", ok,
        detail: ok ? "consent key absent from the revocation tree at this anchor" : `recomputed revocation root ${got} does not match anchor's ${anchor.revocation_root}`,
      };
    }
    if (consent.status === "revoked") {
      if (!consent.value) {
        return {
          name: "consent (membership → revoked)", ok: true, notChecked: true,
          detail: "report does not include the revocation value; the SMT fold cannot be independently confirmed from this report alone — status is shown as claimed, not verified",
        };
      }
      const got = smtComputeRoot(consent.key, consent.value, bitmap, siblings);
      const ok = got === anchor.revocation_root;
      return {
        name: "consent (membership → revoked)", ok,
        detail: ok ? `consent key present (revoked${consent.onset ? `, onset block ${consent.onset.block}` : ""})` : `recomputed revocation root ${got} does not match anchor's ${anchor.revocation_root}`,
      };
    }
    return { name: "consent", ok: false, detail: `unknown consent status "${(consent as { status: string }).status}"` };
  } catch (e) {
    return { name: "consent", ok: false, detail: e instanceof Error ? e.message : String(e) };
  }
}

function stepClaims(ep: NonNullable<ReportLike["episodes"]>[number], anchor: NonNullable<ReportLike["anchor"]>): ReportStep {
  const claims = ep.claims || [];
  if (claims.length === 0) return { name: "claims", ok: true, detail: "no claims on this episode" };
  const results = claims.map((claim): ReportStep => {
    try {
      if (!claim.leaf) return { name: `claim ${claim.check}`, ok: false, detail: "claim carries no leaf hash" };
      if (!claim.detail || !("thresholds" in claim.detail)) {
        return { name: `claim ${claim.check}`, ok: false, detail: "detail.thresholds missing (I-15)" };
      }
      const got = hashObject(claim.detail);
      if (got !== claim.detail_hash) {
        return { name: `claim ${claim.check}`, ok: false, detail: `detailHash recomputed ${got} != report's ${claim.detail_hash}` };
      }
      // §9.6's `claims[]` names `leaf`/`log_index`/`detail_hash`/`result`
      // but no separate inclusion proof for the claim leaf itself — a
      // caller wanting that fold independently confirmed re-derives it
      // with `verifyInclusion(claim.leaf, claim.log_index, anchor.size,
      // proof, anchor.root)` given a proof from `GET /proofs/inclusion`.
      return { name: `claim ${claim.check}`, ok: true, detail: `detailHash matches; result ${claim.result}` };
    } catch (e) {
      return { name: `claim ${claim.check}`, ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  });
  const ok = results.every((r) => r.ok);
  return { name: "claims", ok, detail: results.map((r) => `${r.name}: ${r.ok ? "ok" : r.detail}`).join("; ") };
}

function stepCorpus(ep: NonNullable<ReportLike["episodes"]>[number], report: ReportLike): ReportStep {
  if (typeof ep.corpus_index !== "number" || !ep.inclusion_proof_corpus) {
    return { name: "corpus inclusion", ok: false, detail: "episode carries no corpus inclusion proof" };
  }
  const corpusRoot = report.corpus?.corpus_root;
  const episodeCount = report.corpus?.episode_count;
  if (!corpusRoot || episodeCount === undefined) {
    return { name: "corpus inclusion", ok: false, detail: "report carries no corpus_root/episode_count" };
  }
  const ok = verifyInclusion(ep.leaf, ep.corpus_index, episodeCount, ep.inclusion_proof_corpus, corpusRoot);
  return {
    name: "corpus inclusion", ok,
    detail: ok ? `included in corpus at index ${ep.corpus_index}` : "corpus inclusion proof does not fold to corpus_root",
  };
}

/**
 * PLAN §10.10 steps 3-7 against a Report v1 object, plus `report_hash`
 * recomputation. Returns every step's outcome; `allPassed` is true iff
 * every step (that was actually checkable) passed.
 */
export function verifyReport(report: ReportLike): { steps: ReportStep[]; allPassed: boolean; reportHashOk: boolean | null } {
  const steps: ReportStep[] = [];

  if (!report.anchor) {
    steps.push({ name: "report shape", ok: false, detail: "report carries no anchor" });
    return { steps, allPassed: false, reportHashOk: false };
  }
  const anchor = report.anchor;

  for (const ep of report.episodes || []) {
    steps.push({ ...stepInclusion(ep, anchor), name: `episode ${ep.log_index}: log inclusion` });
    steps.push({ ...stepConsent(ep, anchor), name: `episode ${ep.log_index}: consent` });
    steps.push({ ...stepClaims(ep, anchor), name: `episode ${ep.log_index}: claims` });
    steps.push({ ...stepCorpus(ep, report), name: `episode ${ep.log_index}: corpus inclusion` });
  }
  steps.push(stepConsistency(report));

  let reportHashOk: boolean | null = null;
  if (report.report_hash) {
    try {
      const got = hashObjectExcluding(report as unknown as JsonObject, ["report_hash"]);
      reportHashOk = got === report.report_hash;
      steps.push({ name: "report_hash", ok: reportHashOk, detail: reportHashOk ? "matches" : `recomputed ${got}, report names ${report.report_hash}` });
    } catch (e) {
      reportHashOk = false;
      steps.push({ name: "report_hash", ok: false, detail: e instanceof Error ? e.message : String(e) });
    }
  }

  const allPassed = steps.every((s) => s.ok || s.notChecked);
  return { steps, allPassed, reportHashOk };
}
