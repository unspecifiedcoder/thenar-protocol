/**
 * T-036 — commit & append: manifests, leaves, append receipts, ingest job.
 * Same style as the rest of `services/api/test`: plain `node:assert`-style
 * booleans through tsx, no test framework.
 *
 * Uses the T-011 fixture (`fixtures/lerobot-v3`, 3 episodes) end to end
 * through the real HTTP routes for the happy path (`POST /datasets` →
 * `POST /datasets/{id}/ingest` → `GET /jobs/{id}`), and calls
 * `commitEpisodesFromRefs` directly with synthetic `EpisodeRef`s for the
 * cases that need a controllable single failing episode or a forced salt
 * collision — real files can't isolate a single v3 chunked episode's
 * failure since all three episodes share one data/video chunk file.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, toHex, type Hex } from "viem";
import * as ed from "@noble/ed25519";
import { createApp, type Deps } from "../src/app.ts";
import { KeyStore, type ApiKeyRecord } from "../src/auth.ts";
import { MemoryIdempotencyStore } from "../src/idempotency.ts";
import { TokenBucketLimiter } from "../src/ratelimit.ts";
import { LocalBundleStore } from "../src/store/localBundleStore.ts";
import { MemoryUploadRegistry } from "../src/store/uploadRegistry.ts";
import { NotImplementedChainReader } from "../src/chainReader.ts";
import { Registry } from "../src/registry.ts";
import { LogStore } from "../../log/src/store.ts";
import { ensureOperatorKey } from "../src/ingest/operator.ts";
import type { OperatorSigner } from "../src/ingest/receipt.ts";
import { commitEpisodesFromRefs, type IngestContext } from "../src/ingest/job.ts";
import type { EpisodeRef } from "../src/ingest/lerobot.ts";
import { buildFileEntries, payloadHash } from "../../../packages/protocol/src/payload.ts";
import { manifestHash as computeManifestHash } from "../../../packages/protocol/src/mapping.ts";
import { sign as signObject, keyId as deriveKeyId, verify as verifySignature } from "../../../packages/protocol/src/sign.ts";
import { hashObjectExcluding } from "../../../packages/protocol/src/canonical.ts";

let fails = 0;
const ok = (c: boolean, m: string, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };

const here = dirname(fileURLToPath(import.meta.url));
const V3_DIR = join(here, "fixtures", "lerobot-v3");

const hex = (b: number, n = 32) => "0x" + b.toString(16).padStart(2, "0").repeat(n);
const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const SUPPLIER_KEY = "ingest-supplier-key";
const SUPPLIER_ORG = "org_supplier_ingest";
const apiKeys: ApiKeyRecord[] = [{ key_sha256: sha256Hex(SUPPLIER_KEY), org_id: SUPPLIER_ORG, role: "supplier" }];

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
    bundleStore: new LocalBundleStore(mkdtempSync(join(tmpdir(), "thenar-ingest-bundles-"))),
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

const V3_REL_PATHS = [
  "meta/info.json",
  "meta/episodes/chunk-000/file-000.parquet",
  "meta/tasks.parquet",
  "data/chunk-000/file-000.parquet",
  "videos/observation.images.front/chunk-000/file-000.mp4",
];

/** Uploads every file of the v3 fixture into `bundleStore`/`uploadRegistry` under `orgId`. Returns the `FileEntry[]` for `POST /datasets`. */
async function uploadFixture(deps: Deps, orgId: string) {
  const entries = await buildFileEntries(V3_DIR, V3_REL_PATHS);
  for (const e of entries) {
    const bytes = readFileSync(join(V3_DIR, e.path));
    await deps.bundleStore.put(e.hash, (async function* () { yield bytes; })(), bytes.length);
    await deps.uploadRegistry.putPending(e.hash, e.bytes, orgId);
    await deps.uploadRegistry.markStored(e.hash);
  }
  return entries;
}

// =========================================================================
// End-to-end: POST /datasets -> POST /datasets/{id}/ingest -> GET /jobs/{id}
// =========================================================================
{
  const logStore = new LogStore(":memory:");
  const operator = await makeOperator();
  const registry = new Registry(logStore);
  ensureOperatorKey(logStore, registry, operator);
  const deps = makeDeps({ logStore, registry, operator });
  const app = createApp(deps);
  const headers = { "content-type": "application/json", Authorization: `Bearer ${SUPPLIER_KEY}` };

  const files = await uploadFixture(deps, SUPPLIER_ORG);
  const infoEntry = files.find((f) => f.path === "meta/info.json")!;

  const dsRes = await req(app, "/v1/datasets", {
    method: "POST", headers,
    body: JSON.stringify({ info_json_hash: infoEntry.hash, files }),
  });
  ok(dsRes.status === 201, "POST /datasets -> 201", String(dsRes.status));
  const dataset = await json(dsRes);
  ok(typeof dataset.dataset_id === "string" && dataset.dataset_id.length > 0, "POST /datasets returns a dataset_id");

  const consentSk = ed.utils.randomSecretKey();
  const consentPubkey = toHex(await ed.getPublicKeyAsync(consentSk));

  const ingestBody = {
    terms_hash: hex(0x9a),
    scope_bits: 11,
    source: "real",
    consent: { holder: "contributor", pubkey: consentPubkey, alg: "ed25519", scope_bits: 11 },
  };
  const ingestRes = await req(app, `/v1/datasets/${dataset.dataset_id}/ingest`, {
    method: "POST", headers, body: JSON.stringify(ingestBody),
  });
  ok(ingestRes.status === 202, "POST /datasets/{id}/ingest -> 202", String(ingestRes.status));
  const { job_id } = await json(ingestRes);
  ok(typeof job_id === "string" && job_id.length > 0, "ingest returns a job_id");

  const jobRes = await req(app, `/v1/jobs/${job_id}`, { headers: { Authorization: `Bearer ${SUPPLIER_KEY}` } });
  ok(jobRes.status === 200, "GET /jobs/{id} -> 200", String(jobRes.status));
  const jobBody = await json(jobRes);
  ok(jobBody.status === "done", "job status done", String(jobBody.status));
  ok(jobBody.episodes.length === 3, "3 episodes committed from the v3 fixture", String(jobBody.episodes.length));
  ok(jobBody.errors.length === 0, "no errors on a clean ingest", JSON.stringify(jobBody.errors));
  ok(logStore.size() === 3, "3 leaves appended to the log", String(logStore.size()));

  for (const ep of jobBody.episodes) {
    ok(/^0x[0-9a-f]{64}$/.test(ep.leaf_hash), "episode leaf_hash is a 32-byte hex hash");
    ok(/^0x[0-9a-f]{64}$/.test(ep.salt) , "episode salt is returned (32 bytes hex)");
    ok(typeof ep.submitted_at === "number" && ep.submitted_at > 0, "episode carries submitted_at");

    // receipt verifies against the operator's own key (sign.verify)
    const r = ep.receipt;
    ok(r.leaf_hash === ep.leaf_hash && r.leaf_index === ep.leaf_index, "receipt names this leaf");
    const objHash = hashObjectExcluding(r, ["signature"]);
    const valid = await verifySignature(r.signature.alg, "appendReceipt", objHash, r.signature.sig, ((): Hex => {
      // recover pubkey from the registered signing key
      const row = registry.resolveKey(r.signature.key_id, Math.floor(Date.now() / 1000));
      return row!.pubkey;
    })());
    ok(valid, "AppendReceipt verifies with sign.verify against the operator's registered key");

    // recomputing payloadHash from the bundle store (via the materialised
    // files) matches what was committed
    const meta = logStore.episodeMeta(ep.leaf_hash);
    ok(!!meta, "episode row exists in the log store");
    const manifest = JSON.parse(meta!.manifest as unknown as string);
    const recomputed = payloadHash(manifest.files);
    ok(recomputed === manifest.payload_hash, "recomputed payloadHash matches the stored manifest's payload_hash");
    ok(meta!.payloadHash === manifest.payload_hash, "leaf row's payload_hash matches the manifest");
  }

  // Duplicate refused: re-running the same materialised manifest (fixed
  // salt via a synthetic re-post through /episodes with the exact manifest
  // just logged, freshly signed) -> 409, no new leaf.
  const firstManifest = JSON.parse(logStore.episodeMeta(jobBody.episodes[0].leaf_hash)!.manifest as unknown as string);
  const orgSk = ed.utils.randomSecretKey();
  const orgPubkey = toHex(await ed.getPublicKeyAsync(orgSk));
  if (!logStore.org(SUPPLIER_ORG)) {
    logStore.createOrg({ orgId: SUPPLIER_ORG, name: "ingest supplier", kind: "supplier", status: "active", createdAt: Math.floor(Date.now() / 1000) });
  }
  registry.registerKey(SUPPLIER_ORG, { alg: "ed25519", pubkey: orgPubkey });
  // A distinct manifest (fresh consent_commitment, so a distinct
  // manifestHash) submitted through the SDK path — this must succeed once
  // and then be refused as a duplicate on a second, identical submission.
  const resignedManifest = { ...firstManifest, org_id: SUPPLIER_ORG, consent_commitment: keccak256(toHex("a-fresh-commitment-for-the-sdk-path")) };
  const mHash = computeManifestHash(resignedManifest);
  const sig = await signObject("ed25519", "manifest", mHash, toHex(orgSk));
  resignedManifest.signature = { alg: "ed25519", key_id: deriveKeyId(orgPubkey), sig };
  // register org_id's files as stored too (same hashes, already stored under SUPPLIER_ORG's org — re-mark for this org id if different)
  for (const f of resignedManifest.files) {
    await deps.uploadRegistry.putPending(f.hash, f.bytes, SUPPLIER_ORG);
    await deps.uploadRegistry.markStored(f.hash);
  }
  const dupRes1 = await req(app, "/v1/episodes", {
    method: "POST", headers, body: JSON.stringify({ manifest: resignedManifest }),
  });
  ok(dupRes1.status === 200, "POST /episodes with a fresh manifest -> 200 (new leaf)", String(dupRes1.status) + " " + JSON.stringify(await dupRes1.clone().json().catch(() => null)));
  const dupRes2 = await req(app, "/v1/episodes", {
    method: "POST", headers, body: JSON.stringify({ manifest: resignedManifest }),
  });
  ok(dupRes2.status === 409, "POST /episodes with the same manifest again -> 409 duplicate refused", String(dupRes2.status));
  ok(logStore.size() === 4, "duplicate write added nothing to the log", String(logStore.size()));
}

// =========================================================================
// POST /datasets: a file referenced but not stored -> 422 naming the hash
// =========================================================================
{
  const deps = makeDeps({ logStore: new LogStore(":memory:") });
  const app = createApp(deps);
  const headers = { "content-type": "application/json", Authorization: `Bearer ${SUPPLIER_KEY}` };
  const missingHash = hex(0xee);
  const res = await req(app, "/v1/datasets", {
    method: "POST", headers,
    body: JSON.stringify({ info_json_hash: hex(0x01), files: [{ path: "meta/info.json", bytes: 10, hash: missingHash }] }),
  });
  ok(res.status === 422, "POST /datasets with an unstored file -> 422", String(res.status));
  const body = await json(res);
  ok(body.error.details?.hash === missingHash, "422 names the offending hash");
}

// =========================================================================
// Dataset with 0 episodes -> 422 (an info.json with no episodes at all)
// =========================================================================
{
  const logStore0 = new LogStore(":memory:");
  const registry0 = new Registry(logStore0);
  const operator0 = await makeOperator();
  ensureOperatorKey(logStore0, registry0, operator0);
  const deps = makeDeps({ logStore: logStore0, registry: registry0, operator: operator0 });
  const app = createApp(deps);
  const headers = { "content-type": "application/json", Authorization: `Bearer ${SUPPLIER_KEY}` };

  // A minimal, self-consistent "dataset" with only an info.json and no
  // episode metadata at all — `readDataset` reports 0 episodes.
  const infoJson = Buffer.from(JSON.stringify({ codebase_version: "v3.0", fps: 30, features: {}, robot_type: "so_arm100" }));
  const infoHash = keccak256(infoJson);
  await deps.bundleStore.put(infoHash, (async function* () { yield infoJson; })(), infoJson.length);
  await deps.uploadRegistry.putPending(infoHash, infoJson.length, SUPPLIER_ORG);
  await deps.uploadRegistry.markStored(infoHash);

  const dsRes = await req(app, "/v1/datasets", {
    method: "POST", headers,
    body: JSON.stringify({ info_json_hash: infoHash, files: [{ path: "meta/info.json", bytes: infoJson.length, hash: infoHash }] }),
  });
  ok(dsRes.status === 201, "0-episode fixture: dataset created", String(dsRes.status));
  const dataset = await json(dsRes);

  const ingestRes = await req(app, `/v1/datasets/${dataset.dataset_id}/ingest`, {
    method: "POST", headers,
    body: JSON.stringify({
      terms_hash: hex(0x9a), scope_bits: 1, source: "real",
      consent: { holder: "contributor", pubkey: hex(0x01, 32), alg: "ed25519", scope_bits: 1 },
    }),
  });
  ok(ingestRes.status === 422, "dataset with 0 episodes -> 422", String(ingestRes.status) + " " + JSON.stringify(await ingestRes.clone().json().catch(() => null)));
}

// =========================================================================
// commitEpisodesFromRefs: partial-failure atomicity with a synthetic ref set
// =========================================================================
{
  const logStore = new LogStore(":memory:");
  const operator = await makeOperator();
  const registry = new Registry(logStore);
  ensureOperatorKey(logStore, registry, operator);

  const baseRef = (episodeIndex: number): EpisodeRef => ({
    episodeIndex,
    layout: "per_episode",
    files: [{ path: `data/ep-${episodeIndex}.parquet`, bytes: 10, hash: keccak256(toHex(`ep-${episodeIndex}`)) }],
    range: null,
    frames: 10,
    rateHz: 30,
    durationMs: 333,
    instruction: null,
    channels: [{ name: "action", dtype: "float32", shape: [1] }],
    embodiment: "so_arm100",
    success: null,
  });

  const refs: EpisodeRef[] = [baseRef(0), { ...baseRef(1), embodiment: null }, baseRef(2)];
  const ctx: IngestContext = {
    orgId: "org_atomic", datasetId: "ds_atomic", source: "real",
    termsHash: hex(0x11), scopeBits: 1,
    consent: { holder: "contributor", pubkey: hex(0x22, 32), alg: "ed25519", scope_bits: 1 },
    capturedAt: 1_756_900_000,
  };
  const { episodes, errors } = await commitEpisodesFromRefs({ store: logStore, now: () => 1_756_900_100, operator }, refs, ctx);
  ok(episodes.length === 2, "2 of 3 episodes committed", String(episodes.length));
  ok(errors.length === 1 && errors[0].episode_index === 1, "the null-embodiment episode failed, recorded by index", JSON.stringify(errors));
  ok(logStore.size() === 2, "only the 2 successful episodes wrote leaves (atomicity)", String(logStore.size()));
}

// =========================================================================
// Salt reuse refused (a forced saltFn collision)
// =========================================================================
{
  const logStore = new LogStore(":memory:");
  const operator = await makeOperator();
  const registry = new Registry(logStore);
  ensureOperatorKey(logStore, registry, operator);

  const baseRef = (episodeIndex: number): EpisodeRef => ({
    episodeIndex,
    layout: "per_episode",
    files: [{ path: `data/salt-${episodeIndex}.parquet`, bytes: 10, hash: keccak256(toHex(`salt-${episodeIndex}`)) }],
    range: null, frames: 10, rateHz: 30, durationMs: 333, instruction: null,
    channels: [{ name: "action", dtype: "float32", shape: [1] }],
    embodiment: "so_arm100", success: null,
  });
  const refs: EpisodeRef[] = [baseRef(0), baseRef(1)];
  const ctx: IngestContext = {
    orgId: "org_salt", datasetId: "ds_salt", source: "real",
    termsHash: hex(0x33), scopeBits: 1,
    consent: { holder: "contributor", pubkey: hex(0x44, 32), alg: "ed25519", scope_bits: 1 },
    capturedAt: 1_756_900_000,
  };
  const fixedSalt = toHex(randomBytes(32));
  const { episodes, errors } = await commitEpisodesFromRefs({ store: logStore, now: () => 1_756_900_200, operator }, refs, ctx, () => fixedSalt);
  ok(episodes.length === 1, "only the first episode with a reused salt commits", String(episodes.length));
  ok(errors.length === 1 && errors[0].code === "conflict", "the second (same-salt) episode is refused as a conflict", JSON.stringify(errors));
  ok(logStore.size() === 1, "the refused episode wrote nothing", String(logStore.size()));
}

// =========================================================================
// POST /episodes: bad signature -> 401
// =========================================================================
{
  const deps = makeDeps({ logStore: new LogStore(":memory:") });
  const operator = await makeOperator();
  deps.operator = operator;
  ensureOperatorKey(deps.logStore!, deps.registry, operator);
  const app = createApp(deps);
  const headers = { "content-type": "application/json", Authorization: `Bearer ${SUPPLIER_KEY}` };

  const orgSk = ed.utils.randomSecretKey();
  const orgPubkey = toHex(await ed.getPublicKeyAsync(orgSk));
  deps.logStore!.createOrg({ orgId: SUPPLIER_ORG, name: "ingest supplier", kind: "supplier", status: "active", createdAt: Math.floor(Date.now() / 1000) });
  deps.registry.registerKey(SUPPLIER_ORG, { alg: "ed25519", pubkey: orgPubkey });

  const files = [{ path: "data/ep.parquet", bytes: 4, hash: keccak256(toHex("bad-sig-file")) }];
  await deps.uploadRegistry.putPending(files[0].hash, files[0].bytes, SUPPLIER_ORG);
  await deps.uploadRegistry.markStored(files[0].hash);
  const manifest = {
    v: 1, kind: "capture_manifest", org_id: SUPPLIER_ORG, dataset_id: null,
    source: "real", layout: "per_episode", embodiment: "so_arm100",
    rate_hz: 30, duration_ms: 333, captured_at: 1_756_900_000,
    channels: [{ name: "action", dtype: "float32", shape: [1] }],
    files, range: null,
    payload_hash: payloadHash(files),
    consent_commitment: hex(0x55), terms_hash: hex(0x66), scope_bits: 1,
    task: null, outcome: null, sim: null,
    signature: { alg: "ed25519", key_id: deriveKeyId(orgPubkey), sig: hex(0x00, 64) }, // garbage sig
  };
  const res = await req(app, "/v1/episodes", { method: "POST", headers, body: JSON.stringify({ manifest }) });
  ok(res.status === 401, "POST /episodes with a bad signature -> 401", String(res.status));
}

console.log(fails === 0 ? "\nall ingest tests passed" : `\n${fails} ingest test(s) failed`);
process.exit(fails === 0 ? 0 : 1);
