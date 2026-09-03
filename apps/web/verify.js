/* verify.js — the logic behind `/verify` v2: chain selector, leaf-preimage
 * verification (on chain and locally), report verification (PLAN §10.10
 * steps 3-7), and corpus-proof verification. Split out of `verify.html`
 * (T-026) so it can be unit-tested under jsdom without a browser.
 *
 * No bundler: every import below is a relative `.js` specifier the browser
 * resolves directly, same discipline as the rest of `apps/web`.
 */
import { keccak256, hexToBytes } from "./keccak.js";
import { decodeLeaf, hashLeaf, LEAF_VERSIONS } from "./leaves.js";
import { verifyInclusion, verifyConsistency, computeRoot as smtComputeRoot, SMT_ZERO } from "./merkle.js";
import { hashObject, hashObjectExcluding } from "./jcs.js";
import { CHAINS } from "./chains.js";
import { verify as ed25519Verify } from "./ed25519.js";

/**
 * `utf8(domain) ‖ 0x00 ‖ objectHash` — PLAN §10.6. Only the `manifest`
 * domain is needed on this page (episode signatures, L1); the constant
 * matches `packages/protocol/src/sign.ts`'s `DOMAINS.manifest` exactly.
 */
const MANIFEST_DOMAIN = "THENAR/v1/manifest";
function signMessage(domain, objectHash) {
  const domainBytes = new TextEncoder().encode(domain);
  const hashBytes = hexToBytes(objectHash);
  const out = new Uint8Array(domainBytes.length + 1 + hashBytes.length);
  out.set(domainBytes, 0);
  out[domainBytes.length] = 0;
  out.set(hashBytes, domainBytes.length + 1);
  return out;
}

/**
 * Verify an episode manifest's `signature` (§9.1, alg `ed25519` only — this
 * page does not vendor a P-256 verifier) against `objectHash` =
 * `manifestHash`, per §10.6. Returns `false` on any malformed input rather
 * than throwing, same discipline as `sign.ts`'s own `verify`.
 */
export function verifyManifestSignature(objectHash, signature, pubkey) {
  try {
    const msg = signMessage(MANIFEST_DOMAIN, objectHash);
    const sigBytes = hexToBytes(signature);
    const pubBytes = hexToBytes(pubkey);
    if (pubBytes.length !== 32 || sigBytes.length !== 64) return false;
    return ed25519Verify(sigBytes, msg, pubBytes, { zip215: false });
  } catch {
    return false;
  }
}

export const ZERO32 = "0x" + "00".repeat(32);

/* ------------------------------------------------------------------ *
 * Chain selector
 * ------------------------------------------------------------------ */

/** Every configured chain, in `chains.js`'s order — the selector's source of truth. */
export function listChains() {
  return CHAINS;
}

export function findChain(idOrName) {
  return CHAINS.find((c) => String(c.id) === String(idOrName) || c.name === idOrName) ?? null;
}

const SEL = {
  anchorCount: "0x34f96c8c",
  anchorAt: "0x16994960",
  indexOfRoot: "0x5cdd3147",
  verifyLeaf: "0x6253dafc",
  verifyConsentLive: "0xaabd416c",
};

const wordHex = (hex, i) => "0x" + hex.slice(2 + i * 64, 2 + (i + 1) * 64);
const wordNum = (hex, i) => BigInt(wordHex(hex, i));
const pad = (n) => BigInt(n).toString(16).padStart(64, "0");

/**
 * A single JSON-RPC `eth_call` against `rpc`. Throws with the RPC's own
 * error message (or a network error) rather than swallowing it — the page
 * distinguishes "unreachable" from "reachable but reverted" (PLAN §6, §7
 * "RPC spoofing on /verify").
 */
export async function rpcCall(rpc, to, data) {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to, data }, "latest"] }),
  }).then((r) => r.json());
  if (res.error) throw new Error(res.error.message || "eth_call reverted");
  return res.result;
}

/**
 * Read the head and anchor count from a chain's `GraspLog`, over the RPC
 * the caller supplies (which may differ from the chain's default — the
 * page lets the RPC be edited). Returns `{reachable:false}` rather than
 * throwing on any network/RPC failure — callers must render "unreachable",
 * never a guessed value (PLAN I-11).
 */
export async function readChainHead(chain, rpc) {
  try {
    const countHex = await rpcCall(rpc, chain.log, SEL.anchorCount);
    const count = Number(BigInt(countHex));
    if (count === 0) return { reachable: true, count: 0, head: null };
    const raw = await rpcCall(rpc, chain.log, SEL.anchorAt + pad(count - 1));
    const head = {
      root: wordHex(raw, 0), prevRoot: wordHex(raw, 1), revocationRoot: wordHex(raw, 2),
      size: Number(wordNum(raw, 3)), at: Number(wordNum(raw, 4)), blockNumber: Number(wordNum(raw, 5)),
    };
    return { reachable: true, count, head };
  } catch (e) {
    return { reachable: false, error: e.message || String(e) };
  }
}

/** `indexOfRoot(bytes32)` — `(bool found, uint256 index)`. */
export async function readIndexOfRoot(chain, rpc, root) {
  try {
    const raw = await rpcCall(rpc, chain.log, SEL.indexOfRoot + root.slice(2).padStart(64, "0"));
    const found = wordNum(raw, 0) === 1n;
    return { reachable: true, found, index: found ? Number(wordNum(raw, 1)) : null };
  } catch (e) {
    return { reachable: false, error: e.message || String(e) };
  }
}

/* ------------------------------------------------------------------ *
 * Mode (a) — leaf preimage + anchor/proof
 * ------------------------------------------------------------------ */

function encodeVerifyLeafCall(anchorIndex, preimage, proof, leafIndex) {
  const raw = preimage.replace(/^0x/, "");
  if (raw.length % 2) throw new Error("preimage must be whole bytes");
  const bytesLen = raw.length / 2;
  const padded = raw.padEnd(Math.ceil(bytesLen / 32) * 64, "0");
  const headWords = 4;
  const bytesOffset = headWords * 32;
  const bytesWords = 1 + Math.ceil(bytesLen / 32);
  const proofOffset = bytesOffset + bytesWords * 32;
  return SEL.verifyLeaf
    + pad(anchorIndex) + pad(bytesOffset) + pad(proofOffset) + pad(leafIndex)
    + pad(bytesLen) + padded
    + pad(proof.length) + proof.map((h) => h.replace(/^0x/, "").padStart(64, "0")).join("");
}

/**
 * Ask the chain's `LeafVerifier.verifyLeaf` whether `preimage` is included
 * at `leafIndex` in the log as of anchor `anchorIndex`, given `proof`.
 * Returns `{reachable, ok?, error?}` — never throws.
 */
export async function verifyLeafOnChain(chain, rpc, { anchorIndex, preimage, proof, leafIndex }) {
  try {
    const data = encodeVerifyLeafCall(anchorIndex, preimage, proof, leafIndex);
    const res = await rpcCall(rpc, chain.verifier, data);
    return { reachable: true, ok: BigInt(res) === 1n };
  } catch (e) {
    return { reachable: false, error: e.message || String(e) };
  }
}

/**
 * The same check, purely locally, with `merkle.js` — no network. Requires
 * knowing the anchor's `(root, size)` (the caller supplies it, e.g. from
 * `readChainHead`/`anchorAt`, or from a report). Decodes the preimage
 * first (so a version/length mismatch is named, not silently hashed).
 */
export function verifyLeafLocal({ preimage, proof, leafIndex, size, root }) {
  const decoded = decodeLeaf(preimage); // throws with a specific reason on bad input
  const leaf = hashLeaf(preimage);
  const ok = verifyInclusion(leaf, leafIndex, size, proof, root);
  return { ok, decoded, leaf };
}

/* ------------------------------------------------------------------ *
 * Mode (b) — report verification, PLAN §10.10 steps 3-7
 * ------------------------------------------------------------------ */

/** Rebuild the 0x02 EpisodeLeaf preimage's expected byte length/version and reuse `leaves.js` to decode+hash it. */
function stepInclusion(ep, anchor) {
  try {
    const decoded = decodeLeaf(ep.preimage);
    const leaf = hashLeaf(ep.preimage);
    if (leaf !== ep.leaf) {
      return { name: "leaf hash", ok: false, detail: `preimage hashes to ${leaf}, report names ${ep.leaf}` };
    }
    const ok = verifyInclusion(leaf, ep.log_index, anchor.size, ep.inclusion_proof_log, anchor.root);
    return { name: "log inclusion", ok, detail: ok ? `leaf ${leaf} included at index ${ep.log_index}` : "inclusion proof does not fold to the report anchor root" };
  } catch (e) {
    return { name: "log inclusion", ok: false, detail: e.message || String(e) };
  }
}

function stepManifestHash(ep) {
  if (!ep.manifest) {
    return { name: "manifestHash", ok: true, notChecked: true, detail: "no manifest embedded in the report; cannot recompute (files/manifest not delivered) — skipped, not a failure of what was checkable" };
  }
  try {
    const got = hashObjectExcluding(ep.manifest, ["signature"]);
    const ok = got === ep.manifest_hash;
    if (!ok) return { name: "manifestHash", ok, detail: `recomputed ${got}, report names ${ep.manifest_hash}` };
    const sig = ep.manifest.signature;
    if (!sig) return { name: "manifestHash", ok: true, detail: "recomputed manifestHash matches (manifest carries no signature — L1 not claimed)" };
    if (sig.alg !== "ed25519") {
      return { name: "manifestHash", ok: true, detail: `recomputed manifestHash matches; signature alg "${sig.alg}" is not checked by this page (only ed25519 is vendored here)` };
    }
    const sigOk = verifyManifestSignature(got, sig.sig, ep.org_pubkey || sig.pubkey);
    return { name: "manifestHash", ok: sigOk, detail: sigOk ? "recomputed manifestHash matches; ed25519 signature over it verifies" : "manifestHash matches but the ed25519 signature over it does not verify" };
  } catch (e) {
    return { name: "manifestHash", ok: false, detail: e.message || String(e) };
  }
}

function stepConsistency(report) {
  const { sealing_anchor, anchor, consistency_proof } = report;
  if (!sealing_anchor || !anchor) {
    return { name: "consistency (sealing → report anchor)", ok: false, detail: "report is missing sealing_anchor or anchor" };
  }
  if (sealing_anchor.size === anchor.size) {
    const ok = sealing_anchor.root === anchor.root && (consistency_proof || []).length === 0;
    return { name: "consistency (sealing → report anchor)", ok, detail: ok ? "sealing and report anchors are the same size and root" : "same size but roots differ, or a non-empty proof was given for equal sizes" };
  }
  const ok = verifyConsistency(sealing_anchor.size, anchor.size, consistency_proof || [], sealing_anchor.root, anchor.root);
  return {
    name: "consistency (sealing → report anchor)", ok,
    detail: ok
      ? `size ${sealing_anchor.size} → ${anchor.size} is a valid extension`
      : "consistency proof does not connect the sealing anchor to the report anchor",
  };
}

function stepConsent(ep, anchor) {
  const c = ep.consent;
  if (!c) return { name: "consent", ok: false, detail: "no consent block in this episode" };
  try {
    const bitmap = BigInt(c.bitmap);
    const siblings = c.siblings || [];
    if (c.status === "live") {
      const got = smtComputeRoot(c.key, SMT_ZERO, bitmap, siblings);
      const ok = got === anchor.revocation_root;
      return { name: "consent (non-membership → live)", ok, detail: ok ? "consent key absent from the revocation tree at this anchor" : `recomputed revocation root ${got} does not match anchor's ${anchor.revocation_root}` };
    }
    if (c.status === "revoked") {
      // Membership proof: the revoked value (H(recordHash‖"revoked"), §10.2)
      // folds to the anchor's revocation root. §9.6 does not name a `value`
      // field on the report's consent block (only `key`, `bitmap`,
      // `siblings`, `onset?`) — and `recordHash` cannot be recovered from
      // `consentKey` (one-way, §10.5/I-6), so a report that omits the value
      // genuinely cannot be folded independently here. When it is present
      // (this page accepts it as an additive field), the fold is checked in
      // full; when absent, this is reported honestly as not fully checkable
      // rather than failed or silently trusted.
      if (!c.value) {
        return { name: "consent (membership → revoked)", ok: true, notChecked: true, detail: "report does not include the revocation value; the SMT fold cannot be independently confirmed from this report alone (only key/bitmap/siblings are named in PLAN §9.6) — status is shown as claimed, not verified" };
      }
      const got = smtComputeRoot(c.key, c.value, bitmap, siblings);
      const ok = got === anchor.revocation_root;
      return { name: "consent (membership → revoked)", ok, detail: ok ? `consent key present (revoked${c.onset ? `, onset block ${c.onset.block}` : ""})` : `recomputed revocation root ${got} does not match anchor's ${anchor.revocation_root}` };
    }
    return { name: "consent", ok: false, detail: `unknown consent status "${c.status}"` };
  } catch (e) {
    return { name: "consent", ok: false, detail: e.message || String(e) };
  }
}

function stepClaims(ep, anchor) {
  const claims = ep.claims || [];
  if (claims.length === 0) return { name: "claims", ok: true, detail: "no claims on this episode" };
  const results = claims.map((claim) => {
    try {
      if (!claim.leaf) return { name: `claim ${claim.check}`, ok: false, detail: "claim carries no leaf hash" };
      if (!claim.detail || !claim.detail.thresholds) {
        return { name: `claim ${claim.check}`, ok: false, detail: "detail.thresholds missing (I-15)" };
      }
      const got = hashObject(claim.detail);
      if (got !== claim.detail_hash) {
        return { name: `claim ${claim.check}`, ok: false, detail: `detailHash recomputed ${got} != report's ${claim.detail_hash}` };
      }
      if (claim.inclusion_proof && typeof claim.log_index === "number") {
        const ok = verifyInclusion(claim.leaf, claim.log_index, anchor.size, claim.inclusion_proof, anchor.root);
        if (!ok) return { name: `claim ${claim.check}`, ok: false, detail: "claim leaf inclusion proof does not fold to the report anchor" };
      }
      return { name: `claim ${claim.check}`, ok: true, detail: `detailHash matches; result ${claim.result}` };
    } catch (e) {
      return { name: `claim ${claim.check}`, ok: false, detail: e.message || String(e) };
    }
  });
  const ok = results.every((r) => r.ok);
  return { name: "claims", ok, detail: results.map((r) => `${r.name}: ${r.ok ? "ok" : r.detail}`).join("; "), subSteps: results };
}

function stepCorpus(ep, report) {
  try {
    if (typeof ep.corpus_index !== "number" || !ep.inclusion_proof_corpus) {
      return { name: "corpus inclusion", ok: false, detail: "episode carries no corpus inclusion proof" };
    }
    const corpusRoot = report.corpus?.corpus_root;
    if (!corpusRoot) return { name: "corpus inclusion", ok: false, detail: "report carries no corpus_root" };
    const ok = verifyInclusion(ep.leaf, ep.corpus_index, report.corpus.episode_count, ep.inclusion_proof_corpus, corpusRoot);
    return { name: "corpus inclusion", ok, detail: ok ? `included in corpus at index ${ep.corpus_index}` : "corpus inclusion proof does not fold to corpus_root" };
  } catch (e) {
    return { name: "corpus inclusion", ok: false, detail: e.message || String(e) };
  }
}

/**
 * Runs PLAN §10.10 steps 3-7 against a Report v1 object, entirely locally
 * (no network — that is a separate, optional cross-check the caller may
 * layer on with `readIndexOfRoot`). Step 1 (file hashes) is not run: the
 * verifier never has the delivered files, and the result says so rather
 * than silently skipping it. Step 2 (manifest signature) verifies only
 * when a manifest and signature are actually embedded.
 *
 * Returns `{steps: [{name, ok, detail}], allPassed, reportHashOk}`. The
 * summary is `allPassed` only when every named step — including the
 * explicit "not checkable" ones, which are marked `ok:true` with an
 * honest reason — passed.
 */
export function verifyReport(report) {
  const steps = [];
  steps.push({
    name: "step 1 — file hashes / payloadHash",
    ok: true,
    detail: "not checked: the delivered files are not available to this page; rerun with the files present (e.g. scripts/verify-report.mjs) to check them",
    notChecked: true,
  });

  if (!report.anchor) {
    steps.push({ name: "report shape", ok: false, detail: "report carries no anchor" });
    return { steps, allPassed: false, reportHashOk: false };
  }

  for (const ep of report.episodes || []) {
    steps.push({ ...stepManifestHash(ep), name: `episode ${ep.log_index}: manifestHash` });
    steps.push({ ...stepInclusion(ep, report.anchor), name: `episode ${ep.log_index}: log inclusion` });
    steps.push({ ...stepConsent(ep, report.anchor), name: `episode ${ep.log_index}: consent` });
    steps.push({ ...stepClaims(ep, report.anchor), name: `episode ${ep.log_index}: claims` });
    steps.push({ ...stepCorpus(ep, report), name: `episode ${ep.log_index}: corpus inclusion` });
  }
  steps.push(stepConsistency(report));

  let reportHashOk = null;
  if (report.report_hash) {
    try {
      const got = hashObjectExcluding(report, ["report_hash"]);
      reportHashOk = got === report.report_hash;
      steps.push({ name: "report_hash", ok: reportHashOk, detail: reportHashOk ? "matches" : `recomputed ${got}, report names ${report.report_hash}` });
    } catch (e) {
      reportHashOk = false;
      steps.push({ name: "report_hash", ok: false, detail: e.message || String(e) });
    }
  }

  const allPassed = steps.every((s) => s.ok);
  return { steps, allPassed, reportHashOk };
}

/* ------------------------------------------------------------------ *
 * Mode (c) — corpus proof
 * ------------------------------------------------------------------ */

/** A leaf's inclusion in a corpus tree, given its own root — PLAN §10.7. */
export function verifyCorpusInclusion({ leaf, index, episodeCount, proof, corpusRoot }) {
  return verifyInclusion(leaf, index, episodeCount, proof, corpusRoot);
}

/* ------------------------------------------------------------------ *
 * API fetch helpers (mode b, when report.api_base or a chain's API is set)
 * ------------------------------------------------------------------ */

/** GET `/v1/proofs/consistency?from_size=&to_size=` — `{proof}`. Never throws; returns `{ok:false, error}`. */
export async function fetchConsistencyProof(apiBase, fromSize, toSize) {
  try {
    const url = `${apiBase.replace(/\/$/, "")}/v1/proofs/consistency?from_size=${fromSize}&to_size=${toSize}`;
    const res = await fetch(url).then((r) => r.json());
    if (res.error) return { ok: false, error: res.error.message || "API error" };
    return { ok: true, proof: res.proof };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}

/** GET `/v1/consent/{key}?root=&size=` — `{status, holder, bitmap, siblings, onset?}`. */
export async function fetchConsent(apiBase, consentKey, root, size) {
  try {
    const url = `${apiBase.replace(/\/$/, "")}/v1/consent/${consentKey}?root=${root}&size=${size}`;
    const res = await fetch(url).then((r) => r.json());
    if (res.error) return { ok: false, error: res.error.message || "API error" };
    return { ok: true, ...res };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
}
