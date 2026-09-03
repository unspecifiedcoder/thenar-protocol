/**
 * `services/api/src/registry.ts` — organisation/signing-key registry
 * (T-024): validity windows (D-20/I-14), the duplicate-pubkey and
 * double-revoke edge cases, the public listing shape, org-mismatch on the
 * HTTP routes, and the admin CLI's flows (`bin/thenar-admin.ts`) via
 * direct function calls. Same style as `api.test.ts`: plain booleans
 * through tsx, no test framework.
 */
import { createHash } from "node:crypto";
import { keccak256, type Hex } from "viem";
import { LogStore } from "../../log/src/store.ts";
import { Registry, validatePubkey } from "../src/registry.ts";
import { ApiError } from "../src/errors.ts";
import { KeyStore } from "../src/auth.ts";
import { createApp, type Deps } from "../src/app.ts";
import { MemoryIdempotencyStore } from "../src/idempotency.ts";
import { TokenBucketLimiter } from "../src/ratelimit.ts";
import { LocalBundleStore } from "../src/store/localBundleStore.ts";
import { MemoryUploadRegistry } from "../src/store/uploadRegistry.ts";
import { NotImplementedChainReader } from "../src/chainReader.ts";
import { runAdminCommand, tokenMatches } from "../bin/thenar-admin.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let fails = 0;
const ok = (c: boolean, m: string, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };

/** A `0x`-prefixed hex string of `n` bytes, filled with `byte` and made unique by `seed` in its last byte. */
function fillHex(byte: number, n: number, seed = 0): Hex {
  const bytes = new Array(n).fill(byte.toString(16).padStart(2, "0"));
  bytes[n - 1] = (seed % 256).toString(16).padStart(2, "0");
  return ("0x" + bytes.join("")) as Hex;
}

const ed25519Pubkey = (seed = 0) => fillHex(0x11, 32, seed);
const p256Pubkey = (seed = 0) => ("0x04" + fillHex(0x22, 64, seed).slice(2)) as Hex;
const secp256k1Compressed = (seed = 0) => ("0x02" + fillHex(0x33, 32, seed).slice(2)) as Hex;
const secp256k1Uncompressed = (seed = 0) => ("0x04" + fillHex(0x44, 64, seed).slice(2)) as Hex;

function freshRegistry(): { registry: Registry; store: LogStore; now: { t: number } } {
  const store = new LogStore(":memory:");
  const now = { t: 1_756_900_000 };
  const registry = new Registry(store, () => now.t);
  return { registry, store, now };
}

function throwsApiError(fn: () => unknown, code: string): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return e instanceof ApiError && e.code === code;
  }
}

// =========================================================================
// Pubkey length/prefix validation per alg (T-024 binding rule)
// =========================================================================
{
  ok(!throwsApiError(() => validatePubkey("ed25519", ed25519Pubkey()), "invalid_request"), "ed25519 32B pubkey is accepted");
  ok(throwsApiError(() => validatePubkey("ed25519", fillHex(0x11, 31)), "invalid_request"), "ed25519 31B pubkey rejected");
  ok(throwsApiError(() => validatePubkey("ed25519", fillHex(0x11, 33)), "invalid_request"), "ed25519 33B pubkey rejected");

  ok(!throwsApiError(() => validatePubkey("p256", p256Pubkey()), "invalid_request"), "p256 65B 0x04-prefixed pubkey is accepted");
  ok(throwsApiError(() => validatePubkey("p256", fillHex(0x22, 64)), "invalid_request"), "p256 64B pubkey rejected (wrong length)");
  ok(throwsApiError(() => validatePubkey("p256", ("0x03" + fillHex(0x22, 64).slice(2)) as Hex), "invalid_request"), "p256 65B pubkey not starting 0x04 rejected");

  ok(!throwsApiError(() => validatePubkey("secp256k1", secp256k1Compressed()), "invalid_request"), "secp256k1 33B compressed pubkey is accepted");
  ok(!throwsApiError(() => validatePubkey("secp256k1", secp256k1Uncompressed()), "invalid_request"), "secp256k1 65B uncompressed pubkey is accepted");
  ok(throwsApiError(() => validatePubkey("secp256k1", fillHex(0x33, 32)), "invalid_request"), "secp256k1 32B pubkey rejected");
  ok(throwsApiError(() => validatePubkey("secp256k1", ("0x03" + fillHex(0x44, 64).slice(2)) as Hex), "invalid_request"), "secp256k1 65B pubkey not starting 0x04 rejected");
}

// =========================================================================
// createOrg / issueApiKey
// =========================================================================
{
  const { registry } = freshRegistry();
  const org = registry.createOrg("Acme Robotics", "supplier");
  ok(/^[0-9A-HJKMNP-TV-Z]{26}$/.test(org.orgId), "createOrg: orgId is a 26-char Crockford ULID", org.orgId);
  ok(registry.getOrg(org.orgId)?.name === "Acme Robotics", "getOrg: round-trips the created org");

  const issued = registry.issueApiKey(org.orgId, "supplier");
  ok(typeof issued.plaintext_key === "string" && issued.plaintext_key.length > 0, "issueApiKey: returns a plaintext key");
  ok(issued.org_id === org.orgId && issued.role === "supplier", "issueApiKey: records org and role");

  ok(throwsApiError(() => registry.issueApiKey("does-not-exist", "supplier"), "not_found"), "issueApiKey: unknown org -> not_found");

  // the plaintext key authenticates through a DB-backed KeyStore
  const { store: authStore } = freshRegistry();
  const org2 = new Registry(authStore).createOrg("Beta", "buyer");
  const issued2 = new Registry(authStore).issueApiKey(org2.orgId, "buyer");
  const keyStore = new KeyStore([], authStore);
  const principal = keyStore.authenticate(issued2.plaintext_key);
  ok(principal?.orgId === org2.orgId && principal?.role === "buyer", "KeyStore(store=): authenticates an issued API key");
  ok(keyStore.authenticate("not-the-real-key") === null, "KeyStore(store=): rejects a wrong key");
}

// =========================================================================
// registerKey: keyId, duplicate pubkey -> 409, attestation_level
// =========================================================================
{
  const { registry } = freshRegistry();
  const org = registry.createOrg("Verifier Co", "verifier");
  const pubkey = ed25519Pubkey(1);

  const row = registry.registerKey(org.orgId, { alg: "ed25519", pubkey });
  ok(row.keyId === keccak256(pubkey), "registerKey: keyId = keccak256(pubkeyBytes) (Sec10.6)");
  ok(row.attestation === null, "registerKey: no attestation given -> stored attestation is null");

  ok(
    throwsApiError(() => registry.registerKey(org.orgId, { alg: "ed25519", pubkey }), "conflict"),
    "registerKey: same pubkey twice -> 409 conflict",
  );

  const attested = registry.registerKey(org.orgId, { alg: "ed25519", pubkey: ed25519Pubkey(2), attestation: { model: "x" } });
  ok(attested.attestation === JSON.stringify({ model: "x" }), "registerKey: attestation stored raw");
  const [publicAttested] = registry.listKeys(org.orgId).filter((k) => k.key_id === attested.keyId);
  ok(publicAttested.attestation_level === 1, "listKeys: attestation_level is 1 (T-023 not built yet, never 2)");
  ok(!("attestation" in publicAttested), "listKeys: public shape omits the attestation blob");

  ok(throwsApiError(() => registry.registerKey("no-such-org", { alg: "ed25519", pubkey: ed25519Pubkey(9) }), "not_found"),
    "registerKey: unknown org -> not_found");
}

// =========================================================================
// revokeKey: sets validTo once, double revoke -> 409
// =========================================================================
{
  const { registry, now } = freshRegistry();
  const org = registry.createOrg("Revoker", "supplier");
  const row = registry.registerKey(org.orgId, { alg: "ed25519", pubkey: ed25519Pubkey(3) });
  ok(row.validTo === null, "registerKey: fresh key has no validTo");

  now.t += 100;
  const revoked = registry.revokeKey(org.orgId, row.keyId);
  ok(revoked.validTo === now.t, "revokeKey: sets validTo = now");

  ok(throwsApiError(() => registry.revokeKey(org.orgId, row.keyId), "conflict"), "revokeKey: revoking twice -> 409 conflict");
  ok(throwsApiError(() => registry.revokeKey(org.orgId, keccak256(ed25519Pubkey(123))), "not_found"), "revokeKey: unknown key -> not_found");

  const otherOrg = registry.createOrg("Other", "buyer");
  const otherKey = registry.registerKey(otherOrg.orgId, { alg: "ed25519", pubkey: ed25519Pubkey(4) });
  ok(throwsApiError(() => registry.revokeKey(org.orgId, otherKey.keyId), "not_found"),
    "revokeKey: a key belonging to a different org is not found under this org");
}

// =========================================================================
// resolveKey: [validFrom, validTo) — inclusive start, exclusive end (D-20/I-14)
// =========================================================================
{
  const { registry, now } = freshRegistry();
  const org = registry.createOrg("Resolver", "supplier");
  const row = registry.registerKey(org.orgId, { alg: "ed25519", pubkey: ed25519Pubkey(5) });
  const validFrom = row.validFrom;

  ok(registry.resolveKey(row.keyId, validFrom - 1) === null, "resolveKey: before validFrom -> null");
  ok(registry.resolveKey(row.keyId, validFrom)?.keyId === row.keyId, "resolveKey: at validFrom (inclusive) -> resolves");
  ok(registry.resolveKey(row.keyId, validFrom + 1_000_000)?.keyId === row.keyId, "resolveKey: still-active key resolves far in the future");
  ok(registry.resolveKey(("0x" + "00".repeat(32)) as Hex, validFrom) === null, "resolveKey: unknown keyId -> null");

  now.t = validFrom + 50;
  const revoked = registry.revokeKey(org.orgId, row.keyId);
  ok(registry.resolveKey(row.keyId, revoked.validTo! - 1)?.keyId === row.keyId, "resolveKey: just before validTo -> resolves");
  ok(registry.resolveKey(row.keyId, revoked.validTo!) === null, "resolveKey: at validTo (exclusive boundary) -> null");
  ok(registry.resolveKey(row.keyId, revoked.validTo! + 1) === null, "resolveKey: after validTo -> null");
}

// =========================================================================
// HTTP routes: create/list/revoke, org mismatch -> 403
// =========================================================================
{
  function makeDeps(registry: Registry): Deps {
    return {
      keyStore: new KeyStore([{ key_sha256: sha256("supplier-key"), org_id: "org_a", role: "supplier" }]),
      idempotencyStore: new MemoryIdempotencyStore(),
      rateLimiter: new TokenBucketLimiter(),
      nowMinute: () => Math.floor(Date.now() / 60_000),
      bundleStore: new LocalBundleStore(mkdtempSync(join(tmpdir(), "thenar-registry-bundles-"))),
      uploadRegistry: new MemoryUploadRegistry(),
      chainReader: new NotImplementedChainReader(),
      registry,
    };
  }
  function sha256(s: string): string {
    return createHash("sha256").update(s, "utf8").digest("hex");
  }

  const store = new LogStore(":memory:");
  const registry = new Registry(store);
  registry.createOrg("A", "supplier"); // orgId isn't org_a; routes key off the caller's org_id from the API key, not the org row
  const app = createApp(makeDeps(registry));
  const authed = { Authorization: "Bearer supplier-key" };

  const created = await app.fetch(new Request("http://localhost/v1/orgs/org_a/keys", {
    method: "POST", headers: { ...authed, "content-type": "application/json" },
    body: JSON.stringify({ alg: "ed25519", pubkey: ed25519Pubkey(6) }),
  }));
  ok(created.status === 201, "POST /orgs/{orgId}/keys -> 201", String(created.status));
  const createdBody = await created.json();
  ok(createdBody.attestation === undefined, "POST response omits attestation (public shape)");
  ok(typeof createdBody.key_id === "string", "POST response includes key_id");

  const dup = await app.fetch(new Request("http://localhost/v1/orgs/org_a/keys", {
    method: "POST", headers: { ...authed, "content-type": "application/json" },
    body: JSON.stringify({ alg: "ed25519", pubkey: ed25519Pubkey(6) }),
  }));
  ok(dup.status === 409, "POST duplicate pubkey -> 409", String(dup.status));

  const list = await app.fetch(new Request("http://localhost/v1/orgs/org_a/keys"));
  ok(list.status === 200, "GET /orgs/{orgId}/keys -> 200 public, no auth needed", String(list.status));
  const listBody = await list.json();
  ok(Array.isArray(listBody.items) && listBody.items.length === 1, "GET list: one key listed");
  ok(!("attestation" in listBody.items[0]), "GET list: public shape omits attestation");

  const mismatch = await app.fetch(new Request("http://localhost/v1/orgs/org_b/keys", {
    method: "POST", headers: { ...authed, "content-type": "application/json" },
    body: JSON.stringify({ alg: "ed25519", pubkey: ed25519Pubkey(7) }),
  }));
  ok(mismatch.status === 403, "POST /orgs/org_b/keys with an org_a key -> 403", String(mismatch.status));

  const revoke = await app.fetch(new Request(`http://localhost/v1/orgs/org_a/keys/${createdBody.key_id}/revoke`, {
    method: "POST", headers: authed,
  }));
  ok(revoke.status === 200, "POST revoke -> 200", String(revoke.status));
  const revokeBody = await revoke.json();
  ok(typeof revokeBody.valid_to === "number", "POST revoke response has valid_to set");

  const revokeAgain = await app.fetch(new Request(`http://localhost/v1/orgs/org_a/keys/${createdBody.key_id}/revoke`, {
    method: "POST", headers: authed,
  }));
  ok(revokeAgain.status === 409, "POST revoke twice -> 409", String(revokeAgain.status));
}

// =========================================================================
// Admin CLI: token gate + create-org / issue-key / register-verifier flows
// =========================================================================
{
  ok(tokenMatches("secret", "secret"), "tokenMatches: equal tokens match");
  ok(!tokenMatches("secret", "wrong"), "tokenMatches: unequal tokens do not match");
  ok(!tokenMatches("secret", undefined), "tokenMatches: missing presented token does not match");
  ok(!tokenMatches(undefined, "secret"), "tokenMatches: missing configured token does not match");

  const { registry } = freshRegistry();

  ok((() => { try { runAdminCommand("bogus-command", [], registry); return false; } catch { return true; } })(),
    "runAdminCommand: unknown subcommand throws");

  const org = runAdminCommand("create-org", ["CLI Org", "verifier"], registry) as { orgId: string; kind: string };
  ok(org.kind === "verifier", "runAdminCommand create-org: creates the org");

  const key = runAdminCommand("issue-key", [org.orgId, "verifier"], registry) as { org_id: string; plaintext_key: string };
  ok(key.org_id === org.orgId && typeof key.plaintext_key === "string", "runAdminCommand issue-key: issues an API key for the org");

  const verifierKey = runAdminCommand("register-verifier", [org.orgId, ed25519Pubkey(42), "ed25519"], registry) as { orgId: string; alg: string };
  ok(verifierKey.orgId === org.orgId && verifierKey.alg === "ed25519", "runAdminCommand register-verifier: registers a signing key");

  ok(
    (() => { try { runAdminCommand("create-org", ["X"], registry); return false; } catch { return true; } })(),
    "runAdminCommand create-org: missing kind throws",
  );
  ok(
    (() => { try { runAdminCommand("issue-key", [org.orgId, "not-a-role"], registry); return false; } catch { return true; } })(),
    "runAdminCommand issue-key: invalid role throws",
  );
}

console.log(fails === 0 ? `\nAll registry tests passed.` : `\n${fails} registry test(s) FAILED.`);
process.exit(fails === 0 ? 0 : 1);
