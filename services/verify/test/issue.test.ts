/**
 * T-020 — `issueClaim`/`appendClaim` tests (TASK-020.md "Tests"):
 * round-trip claim -> leaf -> decodeClaim -> signature verifies; missing
 * thresholds refused; downgrade path; idempotency; plus a worker
 * integration test against the real T-011 v3 fixture ("ingest fixture ->
 * after commit, at least timing/kinematics claims exist for each
 * episode" — TASK-020.md binding rules).
 *
 * Same style as the rest of the repo: plain `node:assert`-style booleans
 * through tsx, no test framework.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, toHex, type Hex } from "viem";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { LogStore } from "../../log/src/store.ts";
import { decodeClaim } from "../../../packages/protocol/src/claim.ts";
import { verify as verifySignature, keyId as deriveKeyId, sign as signObject } from "../../../packages/protocol/src/sign.ts";
import { hashObjectExcluding, type JsonObject } from "../../../packages/protocol/src/canonical.ts";
import { issueClaim, appendClaim, MissingThresholdsError, type VerifierSigner } from "../src/issue.ts";
import type { CheckOutcome } from "../src/types.ts";
import { runChecksForEpisode, type WorkerDeps } from "../src/worker.ts";
import { TrajectoryIndex } from "../src/index/trajectory-index.ts";
import { LocalBundleStore } from "../../api/src/store/localBundleStore.ts";
import { readDataset } from "../../api/src/ingest/lerobot.ts";
import { commitEpisodesFromRefs, type IngestContext } from "../../api/src/ingest/job.ts";
import { buildFileEntries } from "../../../packages/protocol/src/payload.ts";

ed.hashes.sha512 = sha512;

let fails = 0;
const ok = (c: boolean, m: string, x = "") => {
  if (!c) fails++;
  console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`);
};

async function makeVerifier(): Promise<VerifierSigner> {
  const sk = ed.utils.randomSecretKey();
  const pubkey = await ed.getPublicKeyAsync(sk);
  return { keyId: deriveKeyId(toHex(pubkey)), privateKey: toHex(sk) };
}

const SUBJECT_LEAF = keccak256(toHex("subject-episode-leaf"));

function baseOutcome(overrides: Partial<CheckOutcome["detail"]> = {}): CheckOutcome {
  return {
    result: "pass",
    level: 3,
    detail: { check_version: "timing.v1.0", thresholds: { max_jitter_ms: 5 }, ...overrides },
  };
}

// ========================================================================
// Round trip: claim -> leaf -> decodeClaim -> signature verifies
// ========================================================================
{
  const store = new LogStore(":memory:");
  const verifier = await makeVerifier();
  const before = store.size();

  const { claim, leafHash, leafIndex } = await issueClaim(SUBJECT_LEAF, "timing.v1", baseOutcome(), verifier, store);

  ok(store.size() === before + 1, "issueClaim appends exactly one leaf");
  ok(leafIndex === before, "leafIndex is the pre-append size");
  ok(claim.result === "pass", "outcome result carried through unchanged (pass, no downgrade)");

  const stored = store.leafAt(leafIndex);
  ok(!!stored && stored.leaf === leafHash, "leaf is retrievable at leafIndex with the returned leafHash");
  ok(!!stored?.preimage, "leaf row carries the claim preimage");

  const decoded = decodeClaim(stored!.preimage as Hex);
  ok(decoded.subjectLeaf.toLowerCase() === SUBJECT_LEAF.toLowerCase(), "decoded subjectLeaf matches");
  ok(decoded.verifierKeyId.toLowerCase() === verifier.keyId.toLowerCase(), "decoded verifierKeyId matches the signer");
  ok(decoded.checkId === 2, "decoded checkId is timing.v1's id (0x0002)");
  ok(decoded.result === 1, "decoded result byte is 1 (pass)");
  ok(decoded.levelAsserted === 3, "decoded levelAsserted matches outcome.level");

  const pubkey = toHex(await ed.getPublicKeyAsync(hexToSeed(verifier.privateKey)));
  const objectHash = hashClaimObject(claim);
  const sigValid = await verifySignature("ed25519", "claim", objectHash, claim.signature.sig as Hex, pubkey);
  ok(sigValid, "claim.signature verifies against the verifier's pubkey over the claim domain (Sec10.6)");

  const claims = store.claimsFor(SUBJECT_LEAF);
  ok(claims.length === 1 && claims[0].check === "timing.v1", "claim row recorded for the subject leaf");
}

// ========================================================================
// Missing thresholds refused (I-15) — nothing written
// ========================================================================
{
  const store = new LogStore(":memory:");
  const verifier = await makeVerifier();
  const before = store.size();

  let threw = false;
  try {
    await issueClaim(
      SUBJECT_LEAF,
      "timing.v1",
      { result: "pass", level: 3, detail: { check_version: "timing.v1.0" } as any },
      verifier,
      store,
    );
  } catch (err) {
    threw = err instanceof MissingThresholdsError;
  }
  ok(threw, "issueClaim throws MissingThresholdsError when detail.thresholds is absent");
  ok(store.size() === before, "nothing appended when thresholds are missing");

  let threw2 = false;
  try {
    await issueClaim(
      SUBJECT_LEAF,
      "timing.v1",
      { result: "pass", level: 3, detail: { thresholds: {} } as any },
      verifier,
      store,
    );
  } catch (err) {
    threw2 = err instanceof MissingThresholdsError;
  }
  ok(threw2, "issueClaim throws MissingThresholdsError when detail.check_version is absent");
  ok(store.size() === before, "nothing appended when check_version is missing");
}

// ========================================================================
// Downgrade path: emit_fail=false, result=fail -> inconclusive + downgraded_from
// ========================================================================
{
  const store = new LogStore(":memory:");
  const verifier = await makeVerifier();

  const outcome: CheckOutcome = {
    result: "fail",
    level: 3,
    detail: { check_version: "dedup.v1.0", thresholds: { T_exact: 0.02, T_near: 0.05 } },
  };
  const { claim } = await issueClaim(SUBJECT_LEAF, "dedup.v1", outcome, verifier, store, {
    config: { enabled: true, blocking: false, emit_fail: false },
  });

  ok(claim.result === "inconclusive", "fail downgraded to inconclusive when emit_fail=false");
  ok((claim.detail as any).downgraded_from === "fail", "detail.downgraded_from records the original result");

  // A check allowed to emit_fail keeps its fail result unchanged.
  const store2 = new LogStore(":memory:");
  const { claim: claim2 } = await issueClaim(SUBJECT_LEAF, "timing.v1", outcome, verifier, store2, {
    config: { enabled: true, blocking: true, emit_fail: true },
  });
  ok(claim2.result === "fail", "emit_fail=true keeps a fail result as fail");
  ok((claim2.detail as any).downgraded_from === undefined, "no downgraded_from marker when not downgraded");
}

// ========================================================================
// Idempotency: (subjectLeaf, check, verifierKeyId, result, detailHash)
// ========================================================================
{
  const store = new LogStore(":memory:");
  const verifier = await makeVerifier();
  const before = store.size();

  const outcome = baseOutcome();
  const first = await issueClaim(SUBJECT_LEAF, "timing.v1", outcome, verifier, store, { now: () => 1_000 });
  const second = await issueClaim(SUBJECT_LEAF, "timing.v1", outcome, verifier, store, { now: () => 2_000 });

  ok(store.size() === before + 1, "a repeat of the exact same outcome does not append a second leaf");
  ok(first.leafHash === second.leafHash && first.leafIndex === second.leafIndex, "repeat issueClaim returns the existing leaf");

  const changed = await issueClaim(
    SUBJECT_LEAF,
    "timing.v1",
    { ...outcome, detail: { ...outcome.detail, extra: "changed" } },
    verifier,
    store,
    { now: () => 3_000 },
  );
  ok(store.size() === before + 2, "a changed outcome (different detail) issues a new claim leaf (append-only)");
  ok(changed.leafHash !== first.leafHash, "the new claim has a different leaf hash");
}

// ========================================================================
// appendClaim (external-verifier shape): no downgrade, I-15 still applies
// ========================================================================
{
  const store = new LogStore(":memory:");
  const verifier = await makeVerifier();

  const unsigned = {
    v: 1 as const,
    kind: "verification_claim" as const,
    subject_leaf: SUBJECT_LEAF,
    verifier_key_id: verifier.keyId,
    check: "kinematics.v1",
    result: "fail" as const,
    level_asserted: 3,
    detail: { check_version: "kinematics.v1.0", thresholds: { max_accel: 50 } },
    issued_at: 1_700_000_000,
  };
  const objectHash = hashClaimObject(unsigned as any);
  const sig = await signObject("ed25519", "claim", objectHash, verifier.privateKey);
  const claim = { ...unsigned, signature: { alg: "ed25519" as const, key_id: verifier.keyId, sig } };

  const { leafHash } = await appendClaim(store, claim as any);
  const claims = store.claimsFor(SUBJECT_LEAF);
  const row = claims.find((c) => c.leafHash === leafHash)!;
  ok(row.result === "fail", "appendClaim does not downgrade an external verifier's fail result");
}

// ========================================================================
// Worker integration: real T-011 v3 fixture -> commit -> claims exist
// ========================================================================
{
  const here = dirname(fileURLToPath(import.meta.url));
  const V3_DIR = join(here, "..", "..", "api", "test", "fixtures", "lerobot-v3");
  const V3_REL_PATHS = [
    "meta/info.json",
    "meta/episodes/chunk-000/file-000.parquet",
    "meta/tasks.parquet",
    "data/chunk-000/file-000.parquet",
    "videos/observation.images.front/chunk-000/file-000.mp4",
  ];

  const store = new LogStore(":memory:");
  const bundleStore = new LocalBundleStore(mkdtempSync(join(tmpdir(), "thenar-verify-bundles-")));
  const verifier = await makeVerifier();
  const trajectoryIndex = new TrajectoryIndex(":memory:");
  const workerDeps: WorkerDeps = { store, bundleStore, verifier, trajectoryIndex };

  const entries = await buildFileEntries(V3_DIR, V3_REL_PATHS);
  for (const e of entries) {
    const bytes = readFileSync(join(V3_DIR, e.path));
    await bundleStore.put(e.hash, (async function* () { yield bytes; })(), bytes.length);
  }

  const { episodes: refs } = await readDataset(V3_DIR);
  ok(refs.length === 3, "v3 fixture yields 3 episode refs", String(refs.length));

  const operatorSk = ed.utils.randomSecretKey();
  const operator = { keyId: deriveKeyId(toHex(await ed.getPublicKeyAsync(operatorSk))), privateKey: toHex(operatorSk) };

  const ctx: IngestContext = {
    orgId: "org_worker_test",
    datasetId: "ds_worker_test",
    source: "teleop_real",
    termsHash: keccak256(toHex("terms")),
    scopeBits: 11,
    consent: { holder: "contributor", pubkey: toHex(await ed.getPublicKeyAsync(ed.utils.randomSecretKey())), alg: "ed25519", scope_bits: 11 },
    capturedAt: Math.floor(Date.now() / 1000),
  };

  const { episodes, errors } = await commitEpisodesFromRefs(
    { store, now: () => Math.floor(Date.now() / 1000), operator, onEpisodeCommitted: (leafHash) => runChecksForEpisode(leafHash, workerDeps) },
    refs,
    ctx,
  );

  ok(errors.length === 0, "no commit errors on the v3 fixture", JSON.stringify(errors));
  ok(episodes.length === 3, "3 episodes committed", String(episodes.length));

  for (const ep of episodes) {
    const claims = store.claimsFor(ep.leaf_hash);
    const checks = claims.map((c) => c.check).sort();
    ok(checks.includes("timing.v1"), `episode ${ep.episode_index} has a timing.v1 claim`, checks.join(","));
    ok(checks.includes("kinematics.v1"), `episode ${ep.episode_index} has a kinematics.v1 claim`, checks.join(","));
    for (const c of claims) {
      ok(c.verifierKeyId.toLowerCase() === verifier.keyId.toLowerCase(), `${c.check} claim signed by the worker's verifier key`);
    }
  }
}

// ------------------------------------------------------------------- helpers

function hexToSeed(hex: Hex): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function hashClaimObject(claim: Record<string, unknown>): Hex {
  return hashObjectExcluding(claim as JsonObject, ["signature"]);
}

console.log(fails === 0 ? "\nissue.test.ts: all checks passed" : `\nissue.test.ts: ${fails} check(s) FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
