/**
 * `services/api` — auth, idempotency, pagination, wallet-sig, rate limiting
 * and every §9 schema, exercised the way the rest of the repo tests things:
 * plain `node:assert`-style booleans through tsx, no test framework.
 */
import { readFileSync, existsSync, mkdtempSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import { createApp, type Deps } from "../src/app.ts";
import { KeyStore, type ApiKeyRecord } from "../src/auth.ts";
import { MemoryIdempotencyStore } from "../src/idempotency.ts";
import { TokenBucketLimiter } from "../src/ratelimit.ts";
import { encodeCursor, decodeCursor, parseLimit, DEFAULT_LIMIT, MAX_LIMIT } from "../src/pagination.ts";
import { downloadMessage, verifyWalletSig } from "../src/walletSig.ts";
import { CaptureManifest } from "../src/schemas/manifest.ts";
import { CorpusManifest } from "../src/schemas/corpusManifest.ts";
import { VerificationClaim } from "../src/schemas/verificationClaim.ts";
import { ConsentRecord } from "../src/schemas/consentRecord.ts";
import { AppendReceipt } from "../src/schemas/appendReceipt.ts";
import { ApiError } from "../src/errors.ts";
import { LocalBundleStore } from "../src/store/localBundleStore.ts";
import { MemoryUploadRegistry } from "../src/store/uploadRegistry.ts";
import { NotImplementedChainReader, type ChainReader, type ReceiptInfo, type CorpusFile } from "../src/chainReader.ts";
import { Registry } from "../src/registry.ts";
import { LogStore } from "../../log/src/store.ts";

let fails = 0;
const ok = (c: boolean, m: string, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };

const hex = (b: number, n = 32) => "0x" + b.toString(16).padStart(2, "0").repeat(n);
const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

// --- fixtures ---------------------------------------------------------------
const SUPPLIER_KEY = "supplier-key-1";
const VERIFIER_KEY = "verifier-key-1";
const apiKeys: ApiKeyRecord[] = [
  { key_sha256: sha256Hex(SUPPLIER_KEY), org_id: "org_supplier", role: "supplier" },
  { key_sha256: sha256Hex(VERIFIER_KEY), org_id: "org_verifier", role: "verifier" },
];

/** A minimal `ChainReader` fake — T-016 supplies the real viem-backed reader. */
class FakeChainReader implements ChainReader {
  constructor(
    private receipts: Map<string, ReceiptInfo> = new Map(),
    private episodes: Map<string, CorpusFile[]> = new Map(),
  ) {}
  async receiptAt(id: string): Promise<ReceiptInfo | null> {
    return this.receipts.get(id) ?? null;
  }
  async corpusEpisodes(corpusId: string): Promise<CorpusFile[]> {
    return this.episodes.get(corpusId) ?? [];
  }
}

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  return {
    keyStore: new KeyStore(apiKeys),
    idempotencyStore: new MemoryIdempotencyStore(),
    rateLimiter: new TokenBucketLimiter(),
    nowMinute: () => Math.floor(Date.now() / 60_000),
    bundleStore: new LocalBundleStore(mkdtempSync(join(tmpdir(), "thenar-api-bundles-"))),
    uploadRegistry: new MemoryUploadRegistry(),
    chainReader: new NotImplementedChainReader(),
    registry: new Registry(new LogStore(":memory:")),
    ...overrides,
  };
}

function req(app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`http://localhost${path}`, init));
}

async function json(res: Response) {
  return res.json() as Promise<any>;
}

// =========================================================================
// Auth
// =========================================================================
{
  const app = createApp(makeDeps());

  const noAuth = await req(app, "/v1/orgs/org_supplier/keys", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  ok(noAuth.status === 401, "missing Authorization -> 401", String(noAuth.status));
  ok((await json(noAuth)).error.code === "unauthorized", "missing Authorization -> code unauthorized");

  const badAuth = await req(app, "/v1/orgs/org_supplier/keys", {
    method: "POST", body: "{}",
    headers: { "content-type": "application/json", Authorization: "Bearer not-a-real-key" },
  });
  ok(badAuth.status === 401, "invalid key -> 401", String(badAuth.status));

  // valid supplier key acting on someone else's org -> forbidden
  const wrongOrg = await req(app, "/v1/orgs/org_other/keys", {
    method: "POST", body: "{}",
    headers: { "content-type": "application/json", Authorization: `Bearer ${SUPPLIER_KEY}` },
  });
  ok(wrongOrg.status === 403, "org acting on another org's rows -> 403", String(wrongOrg.status));

  // /v1/claims requires role verifier; a supplier key is refused
  const wrongRole = await req(app, "/v1/claims", {
    method: "POST", body: "{}",
    headers: { "content-type": "application/json", Authorization: `Bearer ${SUPPLIER_KEY}` },
  });
  ok(wrongRole.status === 403, "/claims with a non-verifier key -> 403", String(wrongRole.status));

  // a verifier key passes auth and reaches body validation (400, not 403)
  const verifierNoBody = await req(app, "/v1/claims", {
    method: "POST", body: "{}",
    headers: { "content-type": "application/json", Authorization: `Bearer ${VERIFIER_KEY}` },
  });
  ok(verifierNoBody.status === 400, "/claims with a verifier key reaches validation", String(verifierNoBody.status));

  // /healthz is public and needs no auth
  const health = await req(app, "/v1/healthz");
  ok(health.status === 200, "/v1/healthz is public", String(health.status));
  ok((await json(health)).ok === true, "/v1/healthz -> { ok: true }");
}

// =========================================================================
// Idempotency
// =========================================================================
{
  const app = createApp(makeDeps());
  const datasetBody = JSON.stringify({ info_json_hash: hex(0xaa), files: [{ path: "a.parquet", bytes: 10, hash: hex(0xbb) }] });
  const headers = { "content-type": "application/json", Authorization: `Bearer ${SUPPLIER_KEY}`, "Idempotency-Key": "idem-1" };

  const first = await req(app, "/v1/datasets", { method: "POST", body: datasetBody, headers });
  const firstBody = await json(first);
  ok(first.status === 501, "first idempotent request reaches the stub", String(first.status));

  const second = await req(app, "/v1/datasets", { method: "POST", body: datasetBody, headers });
  const secondBody = await json(second);
  ok(second.status === first.status, "same key + same body replays the same status");
  ok(JSON.stringify(secondBody) === JSON.stringify(firstBody), "same key + same body replays the same body");

  const differentBody = JSON.stringify({ info_json_hash: hex(0xcc), files: [{ path: "b.parquet", bytes: 20, hash: hex(0xdd) }] });
  const conflict = await req(app, "/v1/datasets", { method: "POST", body: differentBody, headers });
  ok(conflict.status === 409, "same key + different body -> 409", String(conflict.status));
  ok((await json(conflict)).error.code === "conflict", "same key + different body -> code conflict");
}

// =========================================================================
// Pagination
// =========================================================================
{
  const cursor = { k: "2024-01-01T00:00:00Z", id: "01JABCDEF" };
  const encoded = encodeCursor(cursor);
  ok(/^[A-Za-z0-9_-]+$/.test(encoded), "cursor encoding is base64url");
  const decoded = decodeCursor(encoded);
  ok(decoded.k === cursor.k && decoded.id === cursor.id, "cursor round-trips through encode/decode");

  ok(parseLimit(undefined) === DEFAULT_LIMIT, "default limit is 50", String(parseLimit(undefined)));
  ok(parseLimit("10000") === MAX_LIMIT, "limit is clamped to 500", String(parseLimit("10000")));
  ok(parseLimit("25") === 25, "an explicit limit is honoured");

  let badLimitThrew = false;
  try { parseLimit("not-a-number"); } catch (e) { badLimitThrew = e instanceof ApiError; }
  ok(badLimitThrew, "a non-numeric limit throws invalid_request");

  let badCursorThrew = false;
  try { decodeCursor("not-valid-base64url-json"); } catch (e) { badCursorThrew = e instanceof ApiError; }
  ok(badCursorThrew, "a malformed cursor throws invalid_request");
}

// =========================================================================
// Wallet-signature header (EIP-191, ±2 minute window)
// =========================================================================
{
  // A fixed local test key — used only to sign locally, never broadcast.
  const account = privateKeyToAccount("0x1d674a85ee5ed8762a9b7cb2971e8d2f63699a33ce16338ae7087ddcc9eb7c2d");
  const receiptId = "42";
  const nowMinute = Math.floor(Date.now() / 60_000);
  const goodSig = await account.signMessage({ message: downloadMessage(receiptId, nowMinute) });

  const goodHeader = `${account.address}:${nowMinute}:${goodSig}`;
  const verified = await verifyWalletSig(goodHeader, receiptId, nowMinute);
  ok(verified.toLowerCase() === account.address.toLowerCase(), "a correctly signed header verifies");

  let staleThrew = false;
  try { await verifyWalletSig(goodHeader, receiptId, nowMinute + 10); } catch (e) { staleThrew = e instanceof ApiError; }
  ok(staleThrew, "a header outside the ±2 minute window is rejected");

  let tamperedThrew = false;
  // Flip a byte inside `r` (not the trailing recovery byte, which some
  // ecrecover paths normalize away) so the signature reliably fails to verify.
  const tamperedByte = goodSig[10] === "0" ? "1" : "0";
  const tamperedHeader = `${account.address}:${nowMinute}:${goodSig.slice(0, 10)}${tamperedByte}${goodSig.slice(11)}`;
  try { await verifyWalletSig(tamperedHeader, receiptId, nowMinute); } catch (e) { tamperedThrew = e instanceof ApiError; }
  ok(tamperedThrew, "a tampered signature is rejected");

  let missingThrew = false;
  try { await verifyWalletSig(null, receiptId, nowMinute); } catch (e) { missingThrew = e instanceof ApiError; }
  ok(missingThrew, "a missing header is rejected");

  // End-to-end through the route: a valid header with no matching receipt -> 404, not 401.
  const app = createApp(makeDeps({ chainReader: new FakeChainReader() }));
  const dl = await req(app, `/v1/licences/${receiptId}/download`, { headers: { "X-Wallet-Sig": goodHeader } });
  ok(dl.status === 404, "a valid X-Wallet-Sig for an unknown receipt -> 404", String(dl.status));
  const dlBad = await req(app, `/v1/licences/${receiptId}/download`, {});
  ok(dlBad.status === 401, "a missing X-Wallet-Sig on the route -> 401", String(dlBad.status));
}

// =========================================================================
// T-015 — POST /uploads, PUT /uploads/{hash}, GET /licences/{id}/download
// =========================================================================
{
  const app = createApp(makeDeps());
  const authed = { Authorization: `Bearer ${SUPPLIER_KEY}` };

  const { keccak256 } = await import("viem");
  const content = Buffer.from("thenar upload contents for a small fixture file");
  const realHash = keccak256(`0x${content.toString("hex")}`);

  // POST /v1/uploads for content not yet stored -> a PUT target, local store.
  const presign = await req(app, "/v1/uploads", {
    method: "POST",
    body: JSON.stringify({ hash: realHash, bytes: content.length }),
    headers: { "content-type": "application/json", ...authed },
  });
  ok(presign.status === 200, "POST /v1/uploads for new content -> 200", String(presign.status));
  const presignBody = await json(presign);
  ok(presignBody.method === "PUT" && presignBody.url === `/v1/uploads/${realHash}`, "POST /v1/uploads returns the local PUT target");
  ok(typeof presignBody.expires_at === "number", "POST /v1/uploads returns expires_at");

  // PUT the bytes.
  const put = await req(app, `/v1/uploads/${realHash}`, {
    method: "PUT",
    body: content,
    headers: { ...authed, "Content-Length": String(content.length) },
  });
  ok(put.status === 201, "PUT /v1/uploads/{hash} with correct bytes -> 201", String(put.status));
  ok((await json(put)).stored === true, "PUT /v1/uploads/{hash} -> { stored: true }");

  // A repeat POST now reports it's already stored.
  const presignAgain = await req(app, "/v1/uploads", {
    method: "POST",
    body: JSON.stringify({ hash: realHash, bytes: content.length }),
    headers: { "content-type": "application/json", ...authed },
  });
  ok((await json(presignAgain)).stored === true, "POST /v1/uploads for stored content -> { stored: true }");

  // A mismatched PUT (wrong bytes for the claimed hash) -> 422 hash_mismatch, no auth needed to observe the shape.
  const wrongHash = "0x" + "ee".repeat(32);
  const badPut = await req(app, `/v1/uploads/${wrongHash}`, {
    method: "PUT",
    body: content,
    headers: { ...authed, "Content-Length": String(content.length) },
  });
  ok(badPut.status === 422, "PUT /v1/uploads/{hash} with mismatched content -> 422", String(badPut.status));
  const badPutBody = await json(badPut);
  ok(badPutBody.error.code === "unprocessable" && badPutBody.error.details.reason === "hash_mismatch", "422 body names hash_mismatch");

  // --- GET /v1/licences/{id}/download ------------------------------------
  const account = privateKeyToAccount("0x1d674a85ee5ed8762a9b7cb2971e8d2f63699a33ce16338ae7087ddcc9eb7c2d");
  const otherAccount = privateKeyToAccount("0x6665959ebd8d877d2500eb236bc05f13262f8b098fb5f13da0b6da71982d3190");
  const receiptId = "77";
  const corpusId = "corpus_1";

  const receipts = new Map<string, ReceiptInfo>([[receiptId, { buyer: account.address, corpusId }]]);
  const episodes = new Map<string, CorpusFile[]>([[corpusId, [{ path: "a.parquet", hash: realHash, bytes: content.length }]]]);
  const dlApp = createApp(makeDeps({ chainReader: new FakeChainReader(receipts, episodes) }));

  // Seed the download-test app's own bundle store with the same content (each `makeDeps()` gets a fresh store).
  const presign2 = await req(dlApp, "/v1/uploads", {
    method: "POST", body: JSON.stringify({ hash: realHash, bytes: content.length }),
    headers: { "content-type": "application/json", ...authed },
  });
  ok(presign2.status === 200, "seed upload for the download test -> 200", String(presign2.status));
  await req(dlApp, `/v1/uploads/${realHash}`, { method: "PUT", body: content, headers: { ...authed, "Content-Length": String(content.length) } });

  const now = Math.floor(Date.now() / 60_000);
  const sign = async (id: string, minute: number, signer = account) =>
    `${signer.address}:${minute}:${await signer.signMessage({ message: downloadMessage(id, minute) })}`;

  const goodDl = await req(dlApp, `/v1/licences/${receiptId}/download`, { headers: { "X-Wallet-Sig": await sign(receiptId, now) } });
  ok(goodDl.status === 200, "valid buyer signature -> 200", String(goodDl.status));
  const goodDlBody = await json(goodDl);
  ok(goodDlBody.corpus_id === corpusId, "download response carries corpus_id");
  ok(Array.isArray(goodDlBody.files) && goodDlBody.files.length === 1, "download response carries the corpus's files");
  ok(typeof goodDlBody.files[0].url === "string" && typeof goodDlBody.files[0].expires_at === "number", "each file has a signed url + expires_at");

  const wrongBuyerDl = await req(dlApp, `/v1/licences/${receiptId}/download`, { headers: { "X-Wallet-Sig": await sign(receiptId, now, otherAccount) } });
  ok(wrongBuyerDl.status === 403, "a signer who is not the receipt's buyer -> 403", String(wrongBuyerDl.status));

  const expiredDl = await req(dlApp, `/v1/licences/${receiptId}/download`, { headers: { "X-Wallet-Sig": await sign(receiptId, now - 10) } });
  ok(expiredDl.status === 401, "a signature outside the ±2 minute window -> 401", String(expiredDl.status));

  // Follow one of the signed file URLs and fetch the actual bytes back.
  const fileUrl = goodDlBody.files[0].url as string;
  const fetched = await req(dlApp, fileUrl);
  ok(fetched.status === 200, "the signed per-file URL serves the bytes", String(fetched.status));
  const fetchedBytes = Buffer.from(await fetched.arrayBuffer());
  ok(fetchedBytes.equals(content), "the served bytes match what was uploaded");

  // Missing object for a delivered corpus -> 500 naming the hash (never a substitute).
  const missingHash = "0x" + "ab".repeat(32);
  const missingEpisodes = new Map<string, CorpusFile[]>([[corpusId, [{ path: "missing.parquet", hash: missingHash, bytes: 10 }]]]);
  const missingReceipts = new Map<string, ReceiptInfo>([["78", { buyer: account.address, corpusId }]]);
  const missingApp = createApp(makeDeps({ chainReader: new FakeChainReader(missingReceipts, missingEpisodes) }));
  const missingDl = await req(missingApp, `/v1/licences/78/download`, { headers: { "X-Wallet-Sig": await sign("78", now) } });
  ok(missingDl.status === 500, "a missing stored object -> 500", String(missingDl.status));
  const missingBody = await json(missingDl);
  ok(typeof missingBody.error.message === "string" && missingBody.error.message.includes(missingHash), "500 names the missing hash");
}

// =========================================================================
// Rate limiting: 60/min/IP token bucket
// =========================================================================
{
  const limiter = new TokenBucketLimiter();
  const t0 = Date.now();
  let allowed = 0;
  for (let i = 0; i < 60; i++) if (limiter.allow("1.2.3.4", t0)) allowed++;
  ok(allowed === 60, "60 requests within the same instant are all allowed", String(allowed));
  ok(limiter.allow("1.2.3.4", t0) === false, "the 61st request in the same instant is refused");
  ok(limiter.allow("5.6.7.8", t0) === true, "a different IP has its own bucket");
  ok(limiter.allow("1.2.3.4", t0 + 61_000) === true, "the bucket refills after a minute");

  // End-to-end through the route: hammering /consent/:key/revoke past the
  // limit yields 429, independent of body validity.
  const app = createApp(makeDeps());
  const revoke = (ip: string) => req(app, "/v1/consent/" + hex(0x01) + "/revoke", {
    method: "POST", body: "{}", headers: { "content-type": "application/json", "x-forwarded-for": ip },
  });
  let lastStatus = 0;
  for (let i = 0; i < 61; i++) lastStatus = (await revoke("9.9.9.9")).status;
  ok(lastStatus === 429, "the 61st revoke from one IP is rate limited", String(lastStatus));
}

// =========================================================================
// Schemas — one valid + two invalid fixtures each (I-7 closed-schema guard)
// =========================================================================

// --- CaptureManifest v1 (§9.1) ----------------------------------------------
function validManifest() {
  return {
    v: 1, kind: "capture_manifest", org_id: "org_supplier", dataset_id: null,
    source: "real", layout: "per_episode", embodiment: "so_arm100",
    rate_hz: 30, duration_ms: 12400, captured_at: 1756900000,
    channels: [
      { name: "action", dtype: "float32", shape: [6], hz: 30 },
      { name: "observation.images.front", dtype: "video/mp4", shape: [480, 640, 3], hz: 30 },
      { name: "observation.state", dtype: "float32", shape: [6], unit: "rad", hz: 30 },
    ],
    files: [
      { path: "data/chunk-000/file-000.parquet", bytes: 104857600, hash: hex(0x11) },
      { path: "videos/observation.images.front/chunk-000/file-000.mp4", bytes: 734003200, hash: hex(0x22) },
    ],
    range: null,
    payload_hash: hex(0x33), consent_commitment: hex(0x44), terms_hash: hex(0x55),
    scope_bits: 11, task: null, outcome: null, sim: null, signature: null,
  };
}
{
  ok(CaptureManifest.safeParse(validManifest()).success, "CaptureManifest: valid fixture parses");

  const withChainId = { ...validManifest(), chain_id: 43113 };
  const chainIdResult = CaptureManifest.safeParse(withChainId);
  ok(!chainIdResult.success, "CaptureManifest: chain_id is rejected (I-7 closed schema)");

  const unsortedFiles = validManifest();
  unsortedFiles.files = [unsortedFiles.files[1], unsortedFiles.files[0]];
  const unsortedResult = CaptureManifest.safeParse(unsortedFiles);
  ok(!unsortedResult.success, "CaptureManifest: unsorted files[] is rejected");

  // through the real route: auth + validation both fire, in order
  const app = createApp(makeDeps());
  const res = await req(app, "/v1/episodes", {
    method: "POST", body: JSON.stringify({ manifest: withChainId }),
    headers: { "content-type": "application/json", Authorization: `Bearer ${SUPPLIER_KEY}` },
  });
  ok(res.status === 400, "POST /v1/episodes rejects a manifest with chain_id before reaching 501", String(res.status));
  const validRes = await req(app, "/v1/episodes", {
    method: "POST", body: JSON.stringify({ manifest: validManifest() }),
    headers: { "content-type": "application/json", Authorization: `Bearer ${SUPPLIER_KEY}` },
  });
  ok(validRes.status === 501, "POST /v1/episodes accepts a valid manifest and reaches the stub", String(validRes.status));
}

// --- CorpusManifest v1 (§9.2) ------------------------------------------------
{
  const validCorpus = {
    v: 1, kind: "corpus_manifest", org_id: "org_supplier", title: "demo corpus",
    episodes: [hex(0x01), hex(0x02)], corpus_root: hex(0x03), episode_count: 2,
    terms_hash: hex(0x04), task_id: null, filters: { min_badges: ["L0"], exclude_failed_checks: true },
    sealed_at: 1756900000,
  };
  ok(CorpusManifest.safeParse(validCorpus).success, "CorpusManifest: valid fixture parses");

  const withChainId = { ...validCorpus, chain_id: 43113 };
  ok(!CorpusManifest.safeParse(withChainId).success, "CorpusManifest: chain_id is rejected");

  const dupEpisodes = { ...validCorpus, episodes: [hex(0x01), hex(0x01)] };
  ok(!CorpusManifest.safeParse(dupEpisodes).success, "CorpusManifest: duplicate episodes[] is rejected");
}

// --- VerificationClaim v1 (§9.3) --------------------------------------------
{
  const validClaim = {
    v: 1, kind: "verification_claim", subject_leaf: hex(0x01), verifier_key_id: hex(0x02),
    check: "dedup.v1", result: "pass", level_asserted: 3,
    detail: { check_version: "1.0.0", thresholds: { max_similarity: 0.9 } },
    issued_at: 1756900000, signature: { alg: "ed25519", key_id: hex(0x02), sig: "0xabcd" },
  };
  ok(VerificationClaim.safeParse(validClaim).success, "VerificationClaim: valid fixture parses");

  const noThresholds = { ...validClaim, detail: { check_version: "1.0.0" } };
  ok(!VerificationClaim.safeParse(noThresholds).success, "VerificationClaim: missing detail.thresholds is rejected (I-15)");

  const badCheck = { ...validClaim, check: "not_a_real_check.v1" };
  ok(!VerificationClaim.safeParse(badCheck).success, "VerificationClaim: unknown check name is rejected");
}

// --- ConsentRecord v1 (§9.4) -------------------------------------------------
{
  const validConsent = {
    v: 1, kind: "consent_record", holder: "contributor", pubkey: hex(0x01, 32),
    alg: "ed25519", scope_bits: 11, terms_hash: hex(0x02), granted_at: 1756900000,
    nonce: "0x" + "ab".repeat(16),
  };
  ok(ConsentRecord.safeParse(validConsent).success, "ConsentRecord: valid fixture parses");

  const withChainId = { ...validConsent, chain_id: 43113 };
  ok(!ConsentRecord.safeParse(withChainId).success, "ConsentRecord: chain_id is rejected");

  const shortNonce = { ...validConsent, nonce: "0xab" };
  ok(!ConsentRecord.safeParse(shortNonce).success, "ConsentRecord: a nonce shorter than 16 bytes is rejected");
}

// --- AppendReceipt v1 (§9.5) -------------------------------------------------
{
  const validReceipt = {
    v: 1, kind: "append_receipt", leaf_hash: hex(0x01), leaf_index: 17, log_size_after: 18,
    received_at: 1756900000, signature: { alg: "ed25519", key_id: hex(0x02), sig: "0xabcd" },
  };
  ok(AppendReceipt.safeParse(validReceipt).success, "AppendReceipt: valid fixture parses");

  const badKind = { ...validReceipt, kind: "capture_manifest" };
  ok(!AppendReceipt.safeParse(badKind).success, "AppendReceipt: wrong kind literal is rejected");

  const withChainId = { ...validReceipt, chain_id: 43113 };
  ok(!AppendReceipt.safeParse(withChainId).success, "AppendReceipt: chain_id is rejected");
}

// =========================================================================
// Every §12 route exists and is a real 501 (except /healthz), auth-gated
// as the table says.
// =========================================================================
{
  const app = createApp(makeDeps());
  const authed = { Authorization: `Bearer ${SUPPLIER_KEY}` };
  const routes: [string, string, HeadersInit?][] = [
    ["GET", "/v1/jobs/job_1", authed],
    ["GET", "/v1/episodes/" + hex(0x01)],
    ["GET", "/v1/proofs/inclusion?leaf=" + hex(0x01) + "&root=" + hex(0x02) + "&size=1"],
    ["GET", "/v1/proofs/consistency?from_size=1&to_size=2"],
    ["GET", "/v1/consent/" + hex(0x01)],
    ["GET", "/v1/corpora/corpus_1"],
    ["GET", "/v1/corpora/corpus_1/report"],
    ["GET", "/v1/anchors"],
    ["GET", "/v1/anchors/audit"],
  ];
  for (const [method, path, headers] of routes) {
    const res = await req(app, path, { method, headers });
    ok(res.status === 501, `${method} ${path} -> 501 not_implemented`, String(res.status));
  }
}

// =========================================================================
// openapi.json — generated by `pnpm openapi:api`, must parse and cover the
// documented routes.
// =========================================================================
{
  const openapiPath = new URL("../openapi.json", import.meta.url);
  ok(existsSync(openapiPath), "openapi.json has been generated");
  if (existsSync(openapiPath)) {
    const raw = readFileSync(openapiPath, "utf8");
    let doc: any;
    let parsed = false;
    try { doc = JSON.parse(raw); parsed = true; } catch { /* fails below */ }
    ok(parsed, "openapi.json is valid JSON");
    if (parsed) {
      ok(typeof doc.openapi === "string", "openapi.json declares an openapi version");
      ok(doc.paths && doc.paths["/v1/healthz"] !== undefined, "openapi.json documents /v1/healthz");
      ok(doc.paths && doc.paths["/v1/episodes"]?.post !== undefined, "openapi.json documents POST /v1/episodes");
      ok(doc.components?.schemas?.CaptureManifest !== undefined, "openapi.json includes the CaptureManifest schema");
    }
  }
}

console.log(fails === 0 ? "\nall api tests passed\n" : `\n${fails} api test(s) failed\n`);
process.exit(fails ? 1 : 0);
