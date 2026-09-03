/**
 * T-030 — adversarial suite, API level (TASK-030.md "Attacks" 9, 10, 11-12,
 * 16, 17). Same style as the rest of `services/api/test`: plain
 * `node:assert`-style booleans through tsx, no test framework. Built the
 * same way `services/api/test/{ingest,api,proofs}.test.ts` build an app —
 * `createApp(makeDeps(...))` over an in-memory `LogStore`/`Registry`, real
 * HTTP requests via `app.fetch`.
 *
 * Every test asserts the SPECIFIC refusal (status code + `error.code`,
 * or a named check result), never just "it failed".
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as ed from "@noble/ed25519";
import { createApp, type Deps } from "../src/app.ts";
import { KeyStore, type ApiKeyRecord } from "../src/auth.ts";
import { MemoryIdempotencyStore } from "../src/idempotency.ts";
import { TokenBucketLimiter } from "../src/ratelimit.ts";
import { LocalBundleStore } from "../src/store/localBundleStore.ts";
import { MemoryUploadRegistry } from "../src/store/uploadRegistry.ts";
import { NotImplementedChainReader, type ChainReader, type ReceiptInfo, type CorpusFile } from "../src/chainReader.ts";
import { Registry } from "../src/registry.ts";
import { LogStore } from "../../log/src/store.ts";
import { ensureOperatorKey } from "../src/ingest/operator.ts";
import { putCachedJobResult } from "../src/ingest/job.ts";
import type { OperatorSigner } from "../src/ingest/receipt.ts";
import { downloadMessage } from "../src/walletSig.ts";
import { payloadHash } from "../../../packages/protocol/src/payload.ts";
import { manifestHash as computeManifestHash } from "../../../packages/protocol/src/mapping.ts";
import { sign as signObject, verify as verifySignature, keyId as deriveKeyId } from "../../../packages/protocol/src/sign.ts";
import { recordHash, newConsentRecord, consentKey as deriveConsentKey } from "../../../packages/protocol/src/consent.ts";
import { dedupCheck } from "../../verify/src/checks/dedup.ts";
import { TrajectoryIndex } from "../../verify/src/index/trajectory-index.ts";
import { getCheckConfig } from "../../verify/src/config.ts";
import { simSignatureCheck } from "../../verify/src/checks/sim_signature.ts";
import { byId } from "../../../packages/protocol/src/embodiments.ts";

let fails = 0;
let skipped = 0;
const ok = (c: boolean, m: string, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };
const skip = (m: string, reason: string) => { skipped++; console.log(`  SKIP ${m} — ${reason}`); };

const hex = (b: number, n = 32) => "0x" + b.toString(16).padStart(2, "0").repeat(n);
const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const SUPPLIER_KEY = "adversarial-supplier-key";
const SUPPLIER_ORG = "org_adversarial_supplier";
const OTHER_ORG_KEY = "adversarial-other-org-key";
const OTHER_ORG = "org_adversarial_other";
const apiKeys: ApiKeyRecord[] = [
  { key_sha256: sha256Hex(SUPPLIER_KEY), org_id: SUPPLIER_ORG, role: "supplier" },
  { key_sha256: sha256Hex(OTHER_ORG_KEY), org_id: OTHER_ORG, role: "supplier" },
];

async function makeOperator(): Promise<OperatorSigner> {
  const sk = ed.utils.randomSecretKey();
  const pubkey = await ed.getPublicKeyAsync(sk);
  return { keyId: deriveKeyId(toHex(pubkey)), privateKey: toHex(sk) };
}

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  const logStore = overrides.logStore ?? new LogStore(":memory:");
  const registry = overrides.registry ?? new Registry(logStore);
  return {
    keyStore: new KeyStore(apiKeys),
    idempotencyStore: new MemoryIdempotencyStore(),
    rateLimiter: new TokenBucketLimiter(),
    nowMinute: () => Math.floor(Date.now() / 60_000),
    bundleStore: new LocalBundleStore(mkdtempSync(join(tmpdir(), "thenar-adversarial-bundles-"))),
    uploadRegistry: new MemoryUploadRegistry(),
    chainReader: new NotImplementedChainReader(),
    registry,
    logStore,
    ...overrides,
  };
}

function req(app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`http://localhost${path}`, init));
}
async function json(res: Response) { return res.json() as Promise<any>; }

class FakeChainReader implements ChainReader {
  constructor(
    private receipts: Map<string, ReceiptInfo> = new Map(),
    private episodes: Map<string, CorpusFile[]> = new Map(),
  ) {}
  async receiptAt(id: string): Promise<ReceiptInfo | null> { return this.receipts.get(id) ?? null; }
  async corpusEpisodes(corpusId: string): Promise<CorpusFile[]> { return this.episodes.get(corpusId) ?? []; }
}

console.log("T-030 — adversarial suite, API level");

// =============================================================================
// Attack 9 (via POST /consent/{key}/revoke) — signature from a different key;
// signed under the manifest domain; replayed for a different consent key.
// =============================================================================
{
  console.log("  attack 9 — revocation forgeries");

  const logStore = new LogStore(":memory:");
  const operator = await makeOperator();
  ensureOperatorKey(logStore, new Registry(logStore), operator);
  const app = createApp(makeDeps({ logStore, operator }));

  async function buildRecord() {
    const sk = ed.utils.randomSecretKey();
    const pubkey = toHex(await ed.getPublicKeyAsync(sk));
    const record = newConsentRecord({
      holder: "contributor", pubkey, alg: "ed25519", scope_bits: 1,
      terms_hash: hex(0x11), granted_at: 1_756_900_000,
    });
    const hashv = recordHash(record);
    const key = deriveConsentKey(hashv);
    return { sk, pubkey, record, key };
  }

  const honest = await buildRecord();
  const honestSig = await signObject("ed25519", "revoke", honest.key, toHex(honest.sk));
  const honestRes = await req(app, `/v1/consent/${honest.key}/revoke`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ record: honest.record, signature: { alg: "ed25519", key_id: deriveKeyId(honest.pubkey), sig: honestSig } }),
  });

  if (honestRes.status !== 200) {
    // `RevokeConsentBody.signature` (services/api/src/schemas/requests.ts)
    // is typed as the §10.6 Signature OBJECT `{alg,key_id,sig}`, but
    // `LogStore.revoke(record, signature: Hex)` (services/log/src/store.ts)
    // expects a raw hex string — a live type mismatch (T-012 in flight:
    // consent.ts is one of the routes named in this task's HARD RULE as
    // concurrently edited). Every revoke request, honest or adversarial,
    // is refused 401 by this bug alone, so an attack-specific 401 here
    // cannot be distinguished from the general breakage.
    skip("attack 9 (API, POST /consent/{key}/revoke)",
      `POST /consent/{key}/revoke currently refuses even a correctly-signed revocation (got ${honestRes.status}, expected 200) — services/api/src/schemas/requests.ts RevokeConsentBody.signature (object) vs services/log/src/store.ts LogStore.revoke's signature:Hex parameter disagree; T-012 route in flight`);
  } else {
    ok(true, "attack 9 sanity: an honestly-signed revocation is accepted -> 200");

    // (a) signature from a DIFFERENT key than the record's own pubkey.
    const a = await buildRecord();
    const strangerSk = ed.utils.randomSecretKey();
    const sigFromStranger = await signObject("ed25519", "revoke", a.key, toHex(strangerSk));
    const resA = await req(app, `/v1/consent/${a.key}/revoke`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ record: a.record, signature: { alg: "ed25519", key_id: deriveKeyId(a.pubkey), sig: sigFromStranger } }),
    });
    ok(resA.status === 401, "attack 9a: revocation signed by a different key than the record's own pubkey -> 401", String(resA.status));
    ok((await json(resA)).error?.code === "unauthorized", "attack 9a: error code is unauthorized");

    // (b) signature made under the manifest domain, not revoke.
    const b = await buildRecord();
    const sigWrongDomain = await signObject("ed25519", "manifest", b.key, toHex(b.sk));
    const resB = await req(app, `/v1/consent/${b.key}/revoke`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ record: b.record, signature: { alg: "ed25519", key_id: deriveKeyId(b.pubkey), sig: sigWrongDomain } }),
    });
    ok(resB.status === 401, "attack 9b: revocation signed under the manifest domain -> 401", String(resB.status));
    ok((await json(resB)).error?.code === "unauthorized", "attack 9b: error code is unauthorized");

    // (c) a genuine revoke signature for record C replayed against record D.
    const c = await buildRecord();
    const d = await buildRecord();
    const sigForC = await signObject("ed25519", "revoke", c.key, toHex(c.sk));
    const resC = await req(app, `/v1/consent/${d.key}/revoke`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ record: d.record, signature: { alg: "ed25519", key_id: deriveKeyId(c.pubkey), sig: sigForC } }),
    });
    ok(resC.status === 401, "attack 9c: a revoke signature for one record replayed against a different one -> 401", String(resC.status));
    ok((await json(resC)).error?.code === "unauthorized", "attack 9c: error code is unauthorized");
  }
}

// =============================================================================
// Attack 10 (via POST /episodes) — manifest signature mutated after signing;
// manifest signed with a key that is not currently valid.
// =============================================================================
{
  console.log("  attack 10 — manifest forgeries");

  const deps = makeDeps({ logStore: new LogStore(":memory:") });
  const operator = await makeOperator();
  deps.operator = operator;
  ensureOperatorKey(deps.logStore!, deps.registry, operator);
  const app = createApp(deps);
  const headers = { "content-type": "application/json", Authorization: `Bearer ${SUPPLIER_KEY}` };

  deps.logStore!.createOrg({ orgId: SUPPLIER_ORG, name: "adversarial supplier", kind: "supplier", status: "active", createdAt: Math.floor(Date.now() / 1000) });

  async function buildManifest(files: { path: string; bytes: number; hash: Hex }[]) {
    return {
      v: 1, kind: "capture_manifest", org_id: SUPPLIER_ORG, dataset_id: null,
      source: "teleop_real", layout: "per_episode", embodiment: "so_arm100",
      rate_hz: 30, duration_ms: 333, captured_at: 1_756_900_000,
      channels: [{ name: "action", dtype: "float32", shape: [1] }],
      files, range: null,
      payload_hash: payloadHash(files),
      consent_commitment: hex(0x55), terms_hash: hex(0x66), scope_bits: 1,
      task: null, outcome: null, sim: null,
      signature: null as any,
    };
  }

  // (a) manifest signature mutated after signing.
  {
    const orgSk = ed.utils.randomSecretKey();
    const orgPubkey = toHex(await ed.getPublicKeyAsync(orgSk));
    deps.registry.registerKey(SUPPLIER_ORG, { alg: "ed25519", pubkey: orgPubkey });

    const files = [{ path: "data/adv10a.parquet", bytes: 4, hash: keccak256(toHex("adv10a-file")) }];
    await deps.uploadRegistry.putPending(files[0].hash, files[0].bytes, SUPPLIER_ORG);
    await deps.uploadRegistry.markStored(files[0].hash);
    const manifest = await buildManifest(files);
    const mHash = computeManifestHash(manifest as any);
    const honestSig = await signObject("ed25519", "manifest", mHash, toHex(orgSk));
    ok(await verifySignature("ed25519", "manifest", mHash, honestSig, orgPubkey), "attack 10a sanity: the honest signature verifies off-band");

    // Flip the signature's last hex nibble — mutated after signing.
    const mutatedSig = (honestSig.slice(0, -1) + (honestSig.endsWith("0") ? "1" : "0")) as Hex;
    manifest.signature = { alg: "ed25519", key_id: deriveKeyId(orgPubkey), sig: mutatedSig };

    const res = await req(app, "/v1/episodes", { method: "POST", headers, body: JSON.stringify({ manifest }) });
    ok(res.status === 401, "attack 10a: a manifest signature mutated after signing -> 401", String(res.status));
    ok((await json(res)).error?.code === "unauthorized", "attack 10a: error code is unauthorized");
  }

  // (b) manifest signed with a key that is not currently valid (revoked).
  {
    const orgSk = ed.utils.randomSecretKey();
    const orgPubkey = toHex(await ed.getPublicKeyAsync(orgSk));
    const keyRow = deps.registry.registerKey(SUPPLIER_ORG, { alg: "ed25519", pubkey: orgPubkey });
    // D-20/I-14: validity is evaluated at (provisionally) request time —
    // revoke the key so it is no longer currently valid, then sign with it.
    deps.registry.revokeKey(SUPPLIER_ORG, keyRow.keyId);

    const files = [{ path: "data/adv10b.parquet", bytes: 4, hash: keccak256(toHex("adv10b-file")) }];
    await deps.uploadRegistry.putPending(files[0].hash, files[0].bytes, SUPPLIER_ORG);
    await deps.uploadRegistry.markStored(files[0].hash);
    const manifest = await buildManifest(files);
    const mHash = computeManifestHash(manifest as any);
    const sig = await signObject("ed25519", "manifest", mHash, toHex(orgSk));
    ok(await verifySignature("ed25519", "manifest", mHash, sig, orgPubkey), "attack 10b sanity: the raw signature itself is cryptographically valid");
    manifest.signature = { alg: "ed25519", key_id: deriveKeyId(orgPubkey), sig };

    const res = await req(app, "/v1/episodes", { method: "POST", headers, body: JSON.stringify({ manifest }) });
    ok(res.status === 401, "attack 10b: a manifest signed with a currently-invalid (revoked) key -> 401", String(res.status));
    ok((await json(res)).error?.code === "unauthorized", "attack 10b: error code is unauthorized");
  }
}

// =============================================================================
// Attack 11 — episode resubmitted with jitter sigma = 0.5deg (through
// dedup.v1 directly): must yield fail-downgraded-to-inconclusive with
// detail.downgraded_from === "fail" (FD-1: dedup.v1 never emits fail).
// =============================================================================
{
  console.log("  attack 11 — dedup.v1 jittered resubmission");

  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gaussian(rand: () => number): number {
    const u1 = Math.max(rand(), 1e-12);
    const u2 = rand();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }
  const RATE_HZ = 30;
  const EMBODIMENT = "franka_panda";
  const panda = byId(EMBODIMENT)!;
  const DOF = panda.dof;
  const LIMITS = panda.jointLimits!;
  type Episode = { state: number[][]; timestamp: number[] };

  function makeTrajectory(rand: () => number, durationS: number, rateHz: number): Episode {
    const frames = Math.round(durationS * rateHz);
    const perJoint = LIMITS.map(([lo, hi]) => {
      const mid = (lo + hi) / 2;
      const amp = (hi - lo) * 0.15;
      return { mid, amp, f1: 0.2 + rand() * 1.2, f2: 0.2 + rand() * 1.2, p1: rand() * 2 * Math.PI, p2: rand() * 2 * Math.PI, w1: 0.4 + rand() * 0.4 };
    });
    const state: number[][] = new Array(frames);
    const timestamp: number[] = new Array(frames);
    for (let i = 0; i < frames; i++) {
      const t = i / rateHz;
      timestamp[i] = t;
      const row = new Array<number>(DOF);
      for (let j = 0; j < DOF; j++) {
        const p = perJoint[j];
        let v = p.mid + p.amp * (p.w1 * Math.sin(2 * Math.PI * p.f1 * t + p.p1) + (1 - p.w1) * Math.sin(2 * Math.PI * p.f2 * t + p.p2));
        const [lo, hi] = LIMITS[j];
        if (v < lo) v = lo;
        if (v > hi) v = hi;
        row[j] = v;
      }
      state[i] = row;
    }
    return { state, timestamp };
  }
  function jitter(rand: () => number, ep: Episode, sigmaRad: number): Episode {
    const state = ep.state.map((row) => row.map((v, j) => {
      let nv = v + gaussian(rand) * sigmaRad;
      const [lo, hi] = LIMITS[j];
      if (nv < lo) nv = lo;
      if (nv > hi) nv = hi;
      return nv;
    }));
    return { state, timestamp: ep.timestamp.slice() };
  }

  const DEG = Math.PI / 180;
  const dedupCfg = getCheckConfig("dedup.v1");
  ok(dedupCfg.emit_fail === false, "attack 11 sanity: config/checks.json pins dedup.v1.emit_fail: false (FD-1)");

  const index = new TrajectoryIndex(":memory:");
  const original = makeTrajectory(mulberry32(0xadb11), 3, RATE_HZ);
  const originalLeaf = ("0x" + "11".padEnd(64, "0")) as Hex;
  const firstOut = dedupCheck(original, EMBODIMENT, originalLeaf, index, dedupCfg);
  ok(firstOut.detail.nearest === null, "attack 11 sanity: the original episode's first submission has no nearest neighbour");

  const resubmitted = jitter(mulberry32(0xadb11 * 100), original, 0.5 * DEG);
  const resubmittedLeaf = ("0x" + "22".padEnd(64, "0")) as Hex;
  const out = dedupCheck(resubmitted, EMBODIMENT, resubmittedLeaf, index, dedupCfg);

  ok(out.result === "inconclusive", "attack 11: episode resubmitted with sigma=0.5deg jitter -> inconclusive (never fail, FD-1)", out.result);
  ok(out.detail.downgraded_from === "fail", "attack 11: the refusal names the would-be fail via detail.downgraded_from", String(out.detail.downgraded_from));
  const nearest = out.detail.nearest as { leaf: string; d: number } | null;
  ok(nearest !== null && nearest.leaf === originalLeaf, "attack 11: the resubmission's nearest neighbour is the original episode's leaf");
  ok(!!nearest && nearest.d < (dedupCfg.thresholds!.T_exact as number), "attack 11: the DTW distance is under T_exact, which is exactly what triggers the would-be-fail downgrade", String(nearest?.d));
}

// =============================================================================
// Attack 12 — manifest declaring a physically-attested source over a
// sim-like fixture (through sim_signature.v1 directly): must never yield
// `pass` (FD-2: sim_signature.v1 stays indicative, would-be fail downgrades
// to inconclusive — see services/verify/src/checks/sim_signature.ts).
// =============================================================================
{
  console.log("  attack 12 — sim_signature.v1 sim-like data declared physically real");

  const RATE = 30;
  const DOF = 6;
  const N = 300;

  // Deterministic sim-like fixture (services/verify/test/sim_signature.test.ts's
  // own construction): perfectly uniform timestamps and quantised, frequently
  // repeating joint values, paired with all-zero motion energy — trips all
  // four sim-signature features.
  const timestamp = Array.from({ length: N }, (_, i) => i / RATE);
  const quantum = 0.01;
  const state = timestamp.map((t) =>
    Array.from({ length: DOF }, (_, j) => {
      const raw = 0.5 * Math.sin(2 * Math.PI * 0.2 * t + j);
      return Math.round(raw / quantum) * quantum;
    }),
  );
  const zeroMotion = new Array(50).fill(0);

  // A manifest attesting to the values `sim_signature.v1` accepts as
  // "physically real, not declared simulation" is "real" at this check's
  // interface (`SimSignatureSource`, `run.ts`'s adapter — a full manifest's
  // `source: "teleop_real"`/`"autonomous_real"` both map to this).
  const out = simSignatureCheck({ timestamp, state }, zeroMotion, "real");

  ok(out.result !== "pass", "attack 12: sim-like data declared physically real never passes sim_signature.v1", out.result);
  ok(out.result === "inconclusive", "attack 12: the would-be fail is downgraded to inconclusive (FD-2 — stays indicative, never blocks L3)", out.result);
  ok(out.detail.downgraded_from === "fail", "attack 12: the refusal names the would-be fail via detail.downgraded_from", String(out.detail.downgraded_from));
  ok(out.level !== 3 || out.result !== "pass", "attack 12: this can never be asserted as a passing L3 claim");
}

// =============================================================================
// Attack 16 — idempotency-key reuse with a changed body; API key of org A
// on org B's job; download signature by a non-buyer.
// =============================================================================
{
  console.log("  attack 16 — API-layer trust boundaries");

  // (a) idempotency-key reuse with a changed body -> 409 conflict.
  {
    const app = createApp(makeDeps({ logStore: new LogStore(":memory:") }));
    const headers = { "content-type": "application/json", Authorization: `Bearer ${SUPPLIER_KEY}`, "Idempotency-Key": "adv16-idem-key" };

    const firstBody = JSON.stringify({ info_json_hash: hex(0xaa), files: [{ path: "a.parquet", bytes: 10, hash: hex(0xbb) }] });
    const first = await req(app, "/v1/datasets", { method: "POST", body: firstBody, headers });
    ok(first.status === 422, "attack 16a sanity: the first request (unstored file) reaches the real handler -> 422", String(first.status));

    const differentBody = JSON.stringify({ info_json_hash: hex(0xcc), files: [{ path: "b.parquet", bytes: 20, hash: hex(0xdd) }] });
    const second = await req(app, "/v1/datasets", { method: "POST", body: differentBody, headers });
    ok(second.status === 409, "attack 16a: reusing the Idempotency-Key with a changed body -> 409", String(second.status));
    ok((await json(second)).error?.code === "conflict", "attack 16a: error code is conflict");
  }

  // (b) API key of org A used against org B's job -> 403 forbidden.
  {
    const logStore = new LogStore(":memory:");
    const registry = new Registry(logStore);
    logStore.createOrg({ orgId: SUPPLIER_ORG, name: "adv16 org A", kind: "supplier", status: "active", createdAt: Math.floor(Date.now() / 1000) });
    logStore.createOrg({ orgId: OTHER_ORG, name: "adv16 org B", kind: "supplier", status: "active", createdAt: Math.floor(Date.now() / 1000) });
    const app = createApp(makeDeps({ logStore, registry }));

    const jobId = "adv16-job-belongs-to-org-a";
    const now = Math.floor(Date.now() / 1000);
    logStore.createJob({ jobId, kind: "ingest", status: "done", payload: null, error: null, createdAt: now, updatedAt: now });
    putCachedJobResult(jobId, { orgId: SUPPLIER_ORG, episodes: [], errors: [] });

    const ownRes = await req(app, `/v1/jobs/${jobId}`, { headers: { Authorization: `Bearer ${SUPPLIER_KEY}` } });
    ok(ownRes.status === 200, "attack 16b sanity: org A reading its own job -> 200", String(ownRes.status));

    const crossOrgRes = await req(app, `/v1/jobs/${jobId}`, { headers: { Authorization: `Bearer ${OTHER_ORG_KEY}` } });
    ok(crossOrgRes.status === 403, "attack 16b: org B's API key reading org A's job -> 403", String(crossOrgRes.status));
    ok((await json(crossOrgRes)).error?.code === "forbidden", "attack 16b: error code is forbidden");
  }

  // (c) download of a licence's files by a signer who is not the buyer -> 403.
  {
    const account = privateKeyToAccount(("0x" + "22".repeat(32)) as Hex);
    const otherAccount = privateKeyToAccount(("0x" + "33".repeat(32)) as Hex);
    const receiptId = "adv16-receipt";
    const corpusId = "adv16-corpus";
    const fileHash = keccak256(toHex("adv16-file-bytes"));
    const receipts = new Map<string, ReceiptInfo>([[receiptId, { buyer: account.address, corpusId }]]);
    const episodes = new Map<string, CorpusFile[]>([[corpusId, [{ path: "a.parquet", hash: fileHash, bytes: 10 }]]]);
    const app = createApp(makeDeps({ chainReader: new FakeChainReader(receipts, episodes) }));

    const now = Math.floor(Date.now() / 60_000);
    const sign = async (id: string, minute: number, signer = account) =>
      `${signer.address}:${minute}:${await signer.signMessage({ message: downloadMessage(id, minute) })}`;

    const nonBuyerRes = await req(app, `/v1/licences/${receiptId}/download`, { headers: { "X-Wallet-Sig": await sign(receiptId, now, otherAccount) } });
    ok(nonBuyerRes.status === 403, "attack 16c: download signed by a non-buyer -> 403", String(nonBuyerRes.status));
    ok((await json(nonBuyerRes)).error?.code === "forbidden", "attack 16c: error code is forbidden");
  }
}

// =============================================================================
// Attack 17 — chain-id injection through the real HTTP path: a manifest
// carrying chain_id is rejected by the closed schema before it ever reaches
// a handler (I-7).
// =============================================================================
{
  console.log("  attack 17 — chain-id injection (closed schema, API path)");

  const deps = makeDeps({ logStore: new LogStore(":memory:") });
  const operator = await makeOperator();
  deps.operator = operator;
  ensureOperatorKey(deps.logStore!, deps.registry, operator);
  const app = createApp(deps);
  const headers = { "content-type": "application/json", Authorization: `Bearer ${SUPPLIER_KEY}` };
  deps.logStore!.createOrg({ orgId: SUPPLIER_ORG, name: "adv17 supplier", kind: "supplier", status: "active", createdAt: Math.floor(Date.now() / 1000) });

  const files = [{ path: "data/adv17.parquet", bytes: 4, hash: keccak256(toHex("adv17-file")) }];
  const manifest: any = {
    v: 1, kind: "capture_manifest", org_id: SUPPLIER_ORG, dataset_id: null,
    source: "teleop_real", layout: "per_episode", embodiment: "so_arm100",
    rate_hz: 30, duration_ms: 333, captured_at: 1_756_900_000,
    channels: [{ name: "action", dtype: "float32", shape: [1] }],
    files, range: null,
    payload_hash: payloadHash(files),
    consent_commitment: hex(0x55), terms_hash: hex(0x66), scope_bits: 1,
    task: null, outcome: null, sim: null, signature: null,
    chain_id: 43114, // the injection
  };

  const res = await req(app, "/v1/episodes", { method: "POST", headers, body: JSON.stringify({ manifest }) });
  ok(res.status === 400, "attack 17: a manifest carrying chain_id is refused at the HTTP boundary -> 400", String(res.status));
  const body = await json(res);
  ok(body.error?.code === "invalid_request", "attack 17: error code is invalid_request");
  const details = JSON.stringify(body.error?.details ?? "");
  ok(/chain_id/i.test(details), "attack 17: the rejection names chain_id", details);
}

console.log(
  fails === 0
    ? `\nadversarial (API): all checks passed${skipped > 0 ? ` (${skipped} case skipped — see report)` : ""}\n`
    : `\n${fails} check(s) failed, ${skipped} skipped\n`,
);
process.exit(fails ? 1 : 0);
