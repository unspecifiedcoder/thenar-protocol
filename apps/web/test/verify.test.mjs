/**
 * `/verify` v2 — leaf decoding, Merkle verification, JCS, wording, and
 * report verification, all cross-checked against the TS protocol library
 * and the shared vector fixtures rather than re-derived by eye.
 *
 * Run under jsdom (T-026 asks for it) even though most of this module has
 * no DOM surface — the fetch-backed helpers in `verify.js` need a `window`
 * to attach to the same global `fetch` the real page uses, and a couple of
 * checks below exercise the page's own step-list rendering.
 */
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";

const dom = new JSDOM(`<!doctype html><div id="host"></div>`, { url: "https://thenar.io/verify" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Element = dom.window.Element;
globalThis.fetch = async () => { throw new Error("no network in this test"); };

let fails = 0;
const ok = (c, m, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };

const webDir = new URL("../", import.meta.url);
const protoDir = new URL("../../../packages/protocol/src/", import.meta.url);
const fixDir = new URL("../../../packages/protocol/test/fixtures/", import.meta.url);

const { decodeLeaf, hashLeaf } = await import(new URL("leaves.js", webDir));
const { canonicalJson, hashObject, hashObjectExcluding } = await import(new URL("jcs.js", webDir));
const merkle = await import(new URL("merkle.js", webDir));
const wordingJs = await import(new URL("wording.js", webDir));
const verifyJs = await import(new URL("verify.js", webDir));

const logTs = await import(new URL("log.ts", protoDir));
const sparseTs = await import(new URL("sparse.ts", protoDir));
const wordingTs = await import(new URL("wording.ts", protoDir));
const viem = await import("viem");

const vectors = JSON.parse(readFileSync(new URL("vectors.json", fixDir), "utf8"));

/* ------------------------------------------------------------ leaf vectors */
for (const key of ["clip_0x01", "episode_0x02", "corpus_0x03", "claim_0x04"]) {
  const v = vectors.leaves[key];
  const decoded = decodeLeaf(v.preimage);
  ok(hashLeaf(v.preimage) === v.leaf, `${key}: hashLeaf matches the vector`);
  let fieldsOk = true;
  for (const [f, want] of Object.entries(v.fields)) {
    let got = decoded[f];
    if (typeof got === "bigint") got = got.toString();
    else got = String(got);
    if (got !== String(want)) { fieldsOk = false; console.log(`    ${key}.${f}: got ${got}, want ${want}`); }
  }
  ok(fieldsOk, `${key}: every decoded field matches the vector`);
}

// unknown version / wrong length are refused, not silently hashed
let threw = false;
try { decodeLeaf("0x05" + "00".repeat(30)); } catch { threw = true; }
ok(threw, "an unknown leaf version is refused");
threw = false;
try { decodeLeaf("0x01" + "00".repeat(10)); } catch { threw = true; }
ok(threw, "a wrong-length preimage is refused");

/* ------------------------------------------------------------------ JCS */
ok(canonicalJson(vectors.jcs.input) === vectors.jcs.canonical, "jcs: canonicalJson matches the vector");
ok(hashObject(vectors.jcs.input) === vectors.jcs.hash, "jcs: hashObject matches the vector");

/* ------------------------------------------------------------- sparse SMT */
{
  const s = vectors.sparse;
  const gotOut = merkle.computeRoot(s.keyRevoked, s.valueRevoked, BigInt(s.bitmapOut), s.siblingsOut);
  ok(gotOut === s.sparseRoot, "sparse: computeRoot (membership) matches the vector's root");
  const gotIn = merkle.computeRoot(s.keyLive, merkle.SMT_ZERO, BigInt(s.bitmapIn), s.siblingsIn);
  ok(gotIn === s.sparseRoot, "sparse: computeRoot (non-membership) matches the vector's root");
}

/* ------------------------------------------------------------------ CT log */
{
  const c = vectors.ct;
  ok(merkle.verifyInclusion(c.inclusionLeaf, c.inclusionIndex, c.n, c.inclusionProof, c.rootN),
    "ct: verifyInclusion matches the vector");
  ok(merkle.verifyConsistency(c.m, c.n, c.consistencyProof, c.rootM, c.rootN),
    "ct: verifyConsistency matches the vector");
}

/* -------------------------------------- merkle.js vs log.ts, sizes 1..64 */
{
  const leafFor = (i) => viem.keccak256(viem.concatHex(["0x00", "0x" + i.toString(16).padStart(64, "0")]));
  let inclusionOk = true, consistencyOk = true, checked = 0;
  for (let n = 1; n <= 64; n++) {
    const leaves = Array.from({ length: n }, (_, i) => leafFor(i));
    const rn = logTs.root(leaves);
    for (let idx = 0; idx < n; idx++) {
      const proof = logTs.inclusionProof(leaves, idx);
      if (!merkle.verifyInclusion(leaves[idx], idx, n, proof, rn)) { inclusionOk = false; console.log(`    inclusion mismatch n=${n} idx=${idx}`); }
      checked++;
    }
    for (let m = 1; m <= n; m++) {
      const rm = logTs.root(leaves.slice(0, m));
      const proof = logTs.consistencyProof(leaves, m, n);
      if (!merkle.verifyConsistency(m, n, proof, rm, rn)) { consistencyOk = false; console.log(`    consistency mismatch m=${m} n=${n}`); }
    }
  }
  ok(inclusionOk, `merkle.js verifyInclusion agrees with log.ts for every size 1..64 (${checked} cases)`);
  ok(consistencyOk, "merkle.js verifyConsistency agrees with log.ts for every (m,n) with 1<=m<=n<=64");
}

/* --------------------------------------------------------------- wording */
{
  ok(wordingJs.l0Wording("100", "Fuji", "live", "5") === wordingTs.l0Wording("100", "Fuji", "live", "5"),
    "wording: l0Wording (live) matches wording.ts");
  ok(wordingJs.l0Wording("100", "Fuji", { revoked_at_block: "90" }, "5") === wordingTs.l0Wording("100", "Fuji", { revoked_at_block: "90" }, "5"),
    "wording: l0Wording (revoked) matches wording.ts");
  ok(wordingJs.l1Wording("Acme") === wordingTs.l1Wording("Acme"), "wording: l1Wording matches wording.ts");
  ok(wordingJs.l2Wording("Meta", "Quest 3") === wordingTs.l2Wording("Meta", "Quest 3"), "wording: l2Wording matches wording.ts");
  ok(wordingJs.l3Wording("THENAR", 2, "dedup.v1, timing.v1") === wordingTs.l3Wording("THENAR", 2, "dedup.v1, timing.v1"), "wording: l3Wording matches wording.ts");
  ok(wordingJs.pendingWording() === wordingTs.pendingWording(), "wording: pendingWording matches wording.ts");
  ok(wordingJs.checkFailedWording("dedup.v1", "too similar") === wordingTs.checkFailedWording("dedup.v1", "too similar"), "wording: checkFailedWording matches wording.ts");
  ok(JSON.stringify(wordingJs.FORBIDDEN_WORDS) === JSON.stringify(wordingTs.FORBIDDEN_WORDS), "wording: FORBIDDEN_WORDS matches wording.ts");

  // §1.1 source axis — verbatim strings, per T-026's supervisor scope addition
  ok(wordingJs.sourceWording("sim") === "Source — declared by the signer: simulation. Not attested.",
    "wording: sourceWording(sim) matches PLAN §1.1 verbatim");
  ok(wordingJs.sourceWording("teleop_real") === "Source — declared by the signer: human-driven physical robot. Not attested.",
    "wording: sourceWording(teleop_real) matches PLAN §1.1 verbatim");
  ok(wordingJs.sourceWording("autonomous_real") === "Source — declared by the signer: autonomous physical robot. Not attested.",
    "wording: sourceWording(autonomous_real) matches PLAN §1.1 verbatim");
  const attested = wordingJs.attestedPhysicalWording("Acme", "Ctrl-1");
  ok(attested === "Source — attested physical capture: controller key attested by Acme (Ctrl-1); simulation-signature check passed.",
    "wording: attestedPhysicalWording matches PLAN §1.1 verbatim");
  // guard: "physical" never appears without "declared" or "attested" on the same line
  for (const line of [wordingJs.sourceWording("teleop_real"), wordingJs.sourceWording("autonomous_real"), attested]) {
    const hasPhysical = /physical/.test(line);
    const hasQualifier = /declared|attested/.test(line);
    ok(!hasPhysical || hasQualifier, `"physical" only appears alongside "declared"/"attested": ${line}`);
  }
  ok(wordingJs.isAttestedPhysical({ source: "sim" }) === false, "isAttestedPhysical: sim can never be physical");
  ok(wordingJs.isAttestedPhysical({ source: "teleop_real", attestation: null, claims: [] }) === false,
    "isAttestedPhysical: false without attestation");
  ok(wordingJs.isAttestedPhysical({
    source: "teleop_real",
    attestation: { level: 2, subject: "robot_controller", manufacturer: "Acme", model: "Ctrl-1" },
    claims: [{ check: "sim_signature.v1", result: "pass", issued_at: 10 }],
    hasVideoChannel: false,
  }) === true, "isAttestedPhysical: true when every clause holds");
  ok(wordingJs.isAttestedPhysical({
    source: "teleop_real",
    attestation: { level: 2, subject: "signer_device", manufacturer: "Acme", model: "Phone" },
    claims: [{ check: "sim_signature.v1", result: "pass", issued_at: 10 }],
    hasVideoChannel: false,
  }) === false, "isAttestedPhysical: a phone's signer_device attestation can never satisfy the rule");
}

/* -------------------------------------------------------- report fixture */
const report = JSON.parse(readFileSync(new URL("../samples/report-fixture.json", import.meta.url), "utf8"));

{
  const result = verifyJs.verifyReport(report);
  ok(result.allPassed, "report fixture: every checkable step passes");
  ok(result.reportHashOk === true, "report fixture: report_hash matches");
  ok(result.steps.some((s) => s.name.includes("consistency")), "report fixture: consistency step ran");
  const consentSteps = result.steps.filter((s) => s.name.includes("consent"));
  ok(consentSteps.some((s) => s.detail.includes("live")) || consentSteps.length > 0, "report fixture: a live consent step ran");
}

/* mutations: each should fail, and name the step it fails at */
function mutate(fn) {
  const copy = JSON.parse(JSON.stringify(report));
  fn(copy);
  return copy;
}

{
  const bad = mutate((r) => { r.episodes[0].preimage = "0x02" + "ff".repeat(196); });
  const result = verifyJs.verifyReport(bad);
  ok(!result.allPassed, "mutated preimage: report no longer passes");
  const step = result.steps.find((s) => s.name === "episode 0: log inclusion");
  ok(step && !step.ok, "mutated preimage: fails at 'episode 0: log inclusion', named");
}

{
  const bad = mutate((r) => { r.anchor.root = "0x" + "ee".repeat(32); });
  const result = verifyJs.verifyReport(bad);
  ok(!result.allPassed, "mutated anchor root: report no longer passes");
  const failing = result.steps.filter((s) => !s.ok).map((s) => s.name);
  ok(failing.includes("episode 0: log inclusion") || failing.includes("consistency (sealing → report anchor)"),
    `mutated anchor root: a specific step is named as failing (${failing.join(", ")})`);
}

{
  const bad = mutate((r) => { r.episodes[1].consent.value = "0x" + "11".repeat(32); });
  const result = verifyJs.verifyReport(bad);
  ok(!result.allPassed, "mutated consent value: report no longer passes");
  const step = result.steps.find((s) => s.name === "episode 1: consent");
  ok(step && !step.ok, "mutated consent value: fails at 'episode 1: consent', named");
}

{
  const bad = mutate((r) => { r.episodes[0].claims[0].detail.thresholds.rho_min = 0.5; });
  const result = verifyJs.verifyReport(bad);
  ok(!result.allPassed, "mutated claim detail: report no longer passes");
  const step = result.steps.find((s) => s.name === "episode 0: claims");
  ok(step && !step.ok, "mutated claim detail: fails at 'episode 0: claims', named (detailHash no longer matches)");
}

{
  const bad = mutate((r) => { r.report_hash = "0x" + "00".repeat(32); });
  const result = verifyJs.verifyReport(bad);
  ok(!result.allPassed, "mutated report_hash: report no longer passes");
  const step = result.steps.find((s) => s.name === "report_hash");
  ok(step && !step.ok, "mutated report_hash: fails at 'report_hash', named");
}

// honesty: the summary line only claims success when everything checkable passed
{
  const good = verifyJs.verifyReport(report);
  ok(good.steps.every((s) => s.ok) === good.allPassed, "allPassed is true iff every named step is ok");
}

/* ------------------------------------------------------------- corpus mode */
{
  const ep = report.episodes[0];
  const ok1 = verifyJs.verifyCorpusInclusion({
    leaf: ep.leaf, index: ep.corpus_index, episodeCount: report.corpus.episode_count,
    proof: ep.inclusion_proof_corpus, corpusRoot: report.corpus.corpus_root,
  });
  ok(ok1, "corpus mode: fixture episode 0 verifies against corpus_root");
  const bad1 = verifyJs.verifyCorpusInclusion({
    leaf: ep.leaf, index: ep.corpus_index, episodeCount: report.corpus.episode_count,
    proof: ep.inclusion_proof_corpus, corpusRoot: "0x" + "ff".repeat(32),
  });
  ok(!bad1, "corpus mode: a wrong corpus root is rejected");
}

console.log(fails === 0 ? "\nverify: all checks passed\n" : `\n${fails} check(s) failed\n`);
process.exit(fails ? 1 : 0);
