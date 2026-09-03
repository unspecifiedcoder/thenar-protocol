/**
 * T-020 — `POST /v1/claims` tests (TASK-020.md "Tests"): round trip,
 * external claim with a bad signature -> 401, wrong bearer role -> 403,
 * unknown check -> 422, idempotency.
 *
 * Same style as the rest of `services/api/test`: plain `node:assert`-style
 * booleans through tsx, no test framework.
 */
import { createHash } from "node:crypto";
import { keccak256, toHex, type Hex } from "viem";
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { createApp, type Deps } from "../src/app.ts";
import { KeyStore, type ApiKeyRecord } from "../src/auth.ts";
import { MemoryIdempotencyStore } from "../src/idempotency.ts";
import { TokenBucketLimiter } from "../src/ratelimit.ts";
import { LocalBundleStore } from "../src/store/localBundleStore.ts";
import { MemoryUploadRegistry } from "../src/store/uploadRegistry.ts";
import { NotImplementedChainReader } from "../src/chainReader.ts";
import { Registry } from "../src/registry.ts";
import { LogStore } from "../../log/src/store.ts";
import { hashObjectExcluding, type JsonObject } from "../../../packages/protocol/src/canonical.ts";
import { sign as signObject, keyId as deriveKeyId } from "../../../packages/protocol/src/sign.ts";

ed.hashes.sha512 = sha512;

let fails = 0;
const ok = (c: boolean, m: string, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };

const sha256Hex = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

function req(app: ReturnType<typeof createApp>, path: string, init: RequestInit = {}) {
  return app.fetch(new Request(`http://localhost${path}`, init));
}
async function json(res: Response) { return res.json() as Promise<any>; }

function makeDeps(overrides: Partial<Deps> = {}): Deps {
  const logStore = overrides.logStore ?? new LogStore(":memory:");
  const registry = overrides.registry ?? new Registry(logStore);
  return {
    keyStore: new KeyStore([]),
    idempotencyStore: new MemoryIdempotencyStore(),
    rateLimiter: new TokenBucketLimiter(),
    nowMinute: () => Math.floor(Date.now() / 60_000),
    bundleStore: new LocalBundleStore(".data/test-bundles-claims"),
    uploadRegistry: new MemoryUploadRegistry(),
    chainReader: new NotImplementedChainReader(),
    registry,
    logStore,
    ...overrides,
  };
}

async function makeVerifierIdentity(registry: Registry, logStore: LogStore, orgId = "org_ext_verifier") {
  if (!logStore.org(orgId)) {
    logStore.createOrg({ orgId, name: "external verifier", kind: "verifier", status: "active", createdAt: Math.floor(Date.now() / 1000) });
  }
  const sk = ed.utils.randomSecretKey();
  const pubkey = toHex(await ed.getPublicKeyAsync(sk));
  const row = registry.registerKey(orgId, { alg: "ed25519", pubkey });
  return { orgId, privateKey: toHex(sk), keyId: row.keyId };
}

function unsignedClaim(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    v: 1,
    kind: "verification_claim",
    subject_leaf: keccak256(toHex("subject-episode")),
    verifier_key_id: "0x" + "00".repeat(32),
    check: "timing.v1",
    result: "pass",
    level_asserted: 3,
    detail: { check_version: "timing.v1.0", thresholds: { max_jitter_ms: 5 } },
    issued_at: 1_700_000_000,
    ...overrides,
  };
}

async function signClaim(claim: Record<string, unknown>, privateKey: Hex) {
  const objectHash = hashObjectExcluding(claim as JsonObject, ["signature"]);
  const sig = await signObject("ed25519", "claim", objectHash, privateKey);
  return { ...claim, signature: { alg: "ed25519", key_id: (claim as any).verifier_key_id, sig } };
}

const VERIFIER_BEARER = "claims-verifier-bearer-key";
const BUYER_BEARER = "claims-buyer-bearer-key";

function bearerKeys(orgId: string): ApiKeyRecord[] {
  return [
    { key_sha256: sha256Hex(VERIFIER_BEARER), org_id: orgId, role: "verifier" },
    { key_sha256: sha256Hex(BUYER_BEARER), org_id: orgId, role: "buyer" },
  ];
}

// ========================================================================
// Round trip: a correctly signed external claim -> 200 {leaf_hash, leaf_index}
// ========================================================================
{
  const logStore = new LogStore(":memory:");
  const registry = new Registry(logStore);
  const verifier = await makeVerifierIdentity(registry, logStore);
  const deps = makeDeps({ logStore, registry, keyStore: new KeyStore(bearerKeys(verifier.orgId)) });
  const app = createApp(deps);

  const claim = await signClaim(unsignedClaim({ verifier_key_id: verifier.keyId }), verifier.privateKey);
  const res = await req(app, "/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${VERIFIER_BEARER}` },
    body: JSON.stringify(claim),
  });
  const body = await json(res);
  ok(res.status === 200, "well-formed signed claim -> 200", `${res.status} ${JSON.stringify(body)}`);
  ok(/^0x[0-9a-f]{64}$/.test(body.leaf_hash), "response carries a leaf_hash");
  ok(typeof body.leaf_index === "number", "response carries a leaf_index");

  const stored = logStore.claimsFor(claim.subject_leaf as Hex);
  ok(stored.length === 1 && stored[0].result === "fail" === false, "claim row recorded with the submitted result");
  ok(stored[0].result === "pass", "stored result matches the submitted claim (no downgrade for external verifiers)");

  // Idempotency: the exact same claim again -> same leaf, not a second one.
  const res2 = await req(app, "/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${VERIFIER_BEARER}` },
    body: JSON.stringify(claim),
  });
  const body2 = await json(res2);
  ok(res2.status === 200, "repeat submission of the identical claim -> 200 (idempotent)", String(res2.status));
  ok(body2.leaf_hash === body.leaf_hash, "repeat submission returns the same leaf_hash");
  ok(logStore.claimsFor(claim.subject_leaf as Hex).length === 1, "no second claim row written on a repeat");
}

// ========================================================================
// Bad signature -> 401
// ========================================================================
{
  const logStore = new LogStore(":memory:");
  const registry = new Registry(logStore);
  const verifier = await makeVerifierIdentity(registry, logStore);
  const deps = makeDeps({ logStore, registry, keyStore: new KeyStore(bearerKeys(verifier.orgId)) });
  const app = createApp(deps);

  const claim = await signClaim(unsignedClaim({ verifier_key_id: verifier.keyId, subject_leaf: keccak256(toHex("bad-sig-subject")) }), verifier.privateKey);
  // Tamper with the signed object after signing -> signature no longer verifies.
  const tampered = { ...claim, result: "fail" };
  const res = await req(app, "/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${VERIFIER_BEARER}` },
    body: JSON.stringify(tampered),
  });
  const body = await json(res);
  ok(res.status === 401, "a claim whose signature does not verify -> 401", `${res.status} ${JSON.stringify(body)}`);
}

// ========================================================================
// Wrong bearer role -> 403
// ========================================================================
{
  const logStore = new LogStore(":memory:");
  const registry = new Registry(logStore);
  const verifier = await makeVerifierIdentity(registry, logStore);
  const deps = makeDeps({ logStore, registry, keyStore: new KeyStore(bearerKeys(verifier.orgId)) });
  const app = createApp(deps);

  const claim = await signClaim(unsignedClaim({ verifier_key_id: verifier.keyId, subject_leaf: keccak256(toHex("wrong-role-subject")) }), verifier.privateKey);
  const res = await req(app, "/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${BUYER_BEARER}` },
    body: JSON.stringify(claim),
  });
  ok(res.status === 403, "a bearer key without role verifier -> 403", String(res.status));
}

// ========================================================================
// Unknown check -> 422
// ========================================================================
{
  const logStore = new LogStore(":memory:");
  const registry = new Registry(logStore);
  const verifier = await makeVerifierIdentity(registry, logStore);
  const deps = makeDeps({ logStore, registry, keyStore: new KeyStore(bearerKeys(verifier.orgId)) });
  const app = createApp(deps);

  // "attestation.v1" is a valid PLAN §9.3 check name (schema-level) that
  // this deployment's config/checks.json does not configure (Phase D) —
  // exactly what "unknown check" means at this boundary.
  const claim = await signClaim(
    unsignedClaim({ verifier_key_id: verifier.keyId, check: "attestation.v1", subject_leaf: keccak256(toHex("unknown-check-subject")) }),
    verifier.privateKey,
  );
  const res = await req(app, "/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${VERIFIER_BEARER}` },
    body: JSON.stringify(claim),
  });
  const body = await json(res);
  ok(res.status === 422, "a check not in config/checks.json -> 422", `${res.status} ${JSON.stringify(body)}`);
  ok(body.error?.code === "unprocessable", "422 error code is unprocessable");
}

// ========================================================================
// Missing bearer auth -> 401 (before any claim parsing)
// ========================================================================
{
  const deps = makeDeps();
  const app = createApp(deps);
  const claim = unsignedClaim();
  const res = await req(app, "/v1/claims", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(claim),
  });
  ok(res.status === 401, "no Authorization header -> 401", String(res.status));
}

console.log(fails === 0 ? "\nclaims.test.ts: all checks passed" : `\nclaims.test.ts: ${fails} check(s) FAILED`);
process.exitCode = fails === 0 ? 0 : 1;
