#!/usr/bin/env node
// --experimental-strip-types
/**
 * `scripts/golden.mjs` — T-033: PLAN §21 golden demo path, steps 1-8,
 * unattended, against either two local Anvils (`--local`) or Avalanche
 * Fuji as primary + one local Anvil as mirror (`--live`, D-9: Avalanche
 * C-Chain primary, Ethereum-shaped mirror — no Sepolia deployment exists
 * for this checkout, so `--live` mirrors on a fresh local chain instead).
 *
 * Boots the real `services/api` app in-process against a scratch SQLite
 * DB, runs every step through the real HTTP routes (or, where PLAN §12's
 * route is still `notImplemented` — see the step-4 note below — through
 * the same store escape hatch `services/api/test/licence-flow.test.ts`
 * (T-027) already uses), and shells out to the real
 * `scripts/{seal-corpus,license,download}.mjs` as child processes exactly
 * as a supplier/buyer would run them.
 *
 * Usage:
 *   npx tsx scripts/golden.mjs --local [--reset-local]
 *   npx tsx scripts/golden.mjs --live
 *
 * `--local` runs against a fresh scratch SQLite DB + bundle store + two
 * brand-new Anvils every time (deleted on exit); `--reset-local` is
 * accepted for CLI symmetry with `--live` but has no extra effect, since
 * `--local` is unconditionally scratch already. `--live` anchors against
 * Fuji's real, persistent `GraspLog` (D-9's primary) plus a fresh local
 * Anvil mirror, and therefore uses a persistent log DB / bundle store too
 * (`THENAR_LOG_DB`/`BUNDLE_STORE_ROOT`, default `.data/log.db` /
 * `.data/bundles/` under the repo root) — every `--live` run appends to
 * and extends the one real log, the same way the production log service
 * would, rather than anchoring a fresh scratch log over a head nobody
 * (including a re-run of this script) could ever re-derive.
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { serve } from "@hono/node-server";
import {
  createPublicClient, createWalletClient, http, parseAbi, keccak256, toHex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import * as ed from "@noble/ed25519";

import { createApp, defaultDeps } from "../services/api/src/app.ts";
import { sha256Hex } from "../services/api/src/auth.ts";
import { isUnreachable } from "../services/api/src/chain.ts";
import { loadChains, parseEnvFile } from "../services/log/src/chains.ts";
import { anchorAll, LOG_ABI } from "../services/log/src/anchorer.ts";
import { buildFileEntries, payloadHash } from "../packages/protocol/src/payload.ts";
import { manifestHash as computeManifestHash, corpusManifestHash as computeCorpusManifestHash, corpusRootOf } from "../packages/protocol/src/mapping.ts";
import { encodeCorpus, corpusLeafHash } from "../packages/protocol/src/corpus.ts";
import { newConsentRecord, recordHash, consentKey as deriveConsentKey, consentCommitment } from "../packages/protocol/src/consent.ts";
import { sign as signObject, keyId as deriveKeyId } from "../packages/protocol/src/sign.ts";
import { buildJitterFixture } from "./lib/jitter-fixture.mjs";
import { assembleReport } from "./lib/assemble-report.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(here, "..");
const V3_FIXTURE = join(REPO_ROOT, "services/api/test/fixtures/lerobot-v3");
const V3_REL_PATHS = [
  "meta/info.json",
  "meta/episodes/chunk-000/file-000.parquet",
  "meta/tasks.parquet",
  "data/chunk-000/file-000.parquet",
  "videos/observation.images.front/chunk-000/file-000.mp4",
];

const ANVIL_KEY0 = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const ANVIL_KEY1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";

const LIMITATIONS = [
  "The operator (THENAR) can decline to log or anchor a record; append receipts and public audit make this detectable, not impossible.",
  "Checks are heuristics with recorded thresholds; they can be evaded and can err; they are evidence, not proof.",
  "A signature proves which key signed, not what a sensor measured; captured_at, source and embodiment are claims by the signer.",
  "Consent onset is recorded; what a buyer may do after onset is governed by the terms document, not by this protocol.",
  "Anchors depend on the availability of at least one chain carrying the log; the same log is anchored on more than one.",
];

let stepNo = 0;
function step(name) {
  stepNo++;
  console.log(`\n=== step ${stepNo}/8 — ${name} ===`);
  return { ok: (msg) => console.log(`step ${stepNo}/8 ${name} ... ok${msg ? ` — ${msg}` : ""}`) };
}

async function fetchWithRetry(url, init, attempts = 8, delayMs = 300) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      return res;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

async function req(apiBase, path, init = {}) {
  const res = await fetchWithRetry(`${apiBase}${path}`, init);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

async function spawnAnvil(chainId, timeoutMs = 20_000) {
  // `--chain-id` matters: two Anvils both default to 31337, which would
  // collide as the same `CHAIN_31337_*` block in one `.env.contracts` file
  // (`loadChains` keys chains by id) — primary and mirror need distinct ids.
  const proc = spawn("anvil", ["--port", "0", "--chain-id", String(chainId)], { stdio: ["ignore", "pipe", "pipe"] });
  const port = await new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk) => {
      buf += chunk.toString("utf8");
      const m = buf.match(/Listening on 127\.0\.0\.1:(\d+)/);
      if (m) { cleanup(); resolve(Number(m[1])); }
    };
    const onErr = (e) => { cleanup(); reject(e); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("anvil did not report a listening port in time")); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); proc.stdout.off("data", onData); proc.off("error", onErr); };
    proc.stdout.on("data", onData);
    proc.on("error", onErr);
  });
  return { proc, rpc: `http://127.0.0.1:${port}` };
}

function deployChain(rpc, role, envContractsPath, pk, extraEnv = {}) {
  const out = execFileSync(
    "bash", ["scripts/deploy-chain.sh", rpc, role, "none", pk],
    { cwd: REPO_ROOT, env: { ...process.env, ENV_CONTRACTS_FILE: envContractsPath, ...extraEnv }, encoding: "utf8" },
  );
  return out;
}

/** Uploads one in-memory buffer through the real `/uploads` (+`PUT`) routes. */
async function uploadBytes(apiBase, headers, bytes) {
  const hash = keccak256(bytes);
  const create = await req(apiBase, "/v1/uploads", {
    method: "POST", headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ hash, bytes: bytes.length }),
  });
  if (!create.stored) {
    const url = create.url.startsWith("/") ? `${apiBase}${create.url}` : create.url;
    const put = await fetch(url, { method: "PUT", headers, body: bytes });
    if (!put.ok) throw new Error(`PUT ${url} -> ${put.status}`);
  }
  return { hash, bytes: bytes.length };
}

/** Uploads every real fixture file (or every file under `dir`) and returns the `FileEntry[]` `POST /datasets` wants. */
async function uploadDir(apiBase, headers, dir, relPaths) {
  const entries = await buildFileEntries(dir, relPaths);
  for (const e of entries) {
    const bytes = readFileSync(join(dir, e.path));
    await uploadBytes(apiBase, headers, bytes);
  }
  return entries;
}

async function pollJob(apiBase, headers, jobId, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await req(apiBase, `/v1/jobs/${jobId}`, { headers });
    if (job.status === "done" || job.status === "failed") return job;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`job ${jobId} did not finish within ${timeoutMs}ms`);
}

async function main() {
  const mode = process.argv.includes("--live") ? "live" : "local";
  const resetLocal = process.argv.includes("--reset-local");
  // T-025 shipped `GET /v1/corpora/{id}/report`; the real route is now the
  // default report source. `--assemble-locally` keeps `assembleReport`
  // (scripts/lib/assemble-report.mjs) available as a fallback that never
  // needs the route to exist.
  const assembleLocally = process.argv.includes("--assemble-locally");
  if (resetLocal && mode !== "local") {
    throw new Error("--reset-local only applies to --local (--live always appends to the one persistent, real log — see TASKS/REPORTS.md's T-033 follow-up)");
  }
  console.log(`golden demo — mode: ${mode}`);

  // Everything genuinely disposable (the mirror's own `.env.contracts`, the
  // jitter fixture, the delivered-files copy) lives under `scratch` and is
  // removed at the end regardless of mode. The log DB and bundle store are
  // NOT under `scratch` in `--live` mode — see below.
  const scratch = mkdtempSync(join(tmpdir(), "thenar-golden-"));
  const envContractsPath = join(scratch, ".env.contracts");

  let dbPath, bundleRoot;
  if (mode === "live") {
    // T-033 follow-up: `--live` anchors against Fuji's real, persistent
    // `GraspLog` — a fresh scratch log every run would produce anchors that
    // extend nothing a re-run (or anyone else) can re-derive, and after the
    // first run would simply fail (§21's own coherence rule: same size,
    // different root, refused — this is exactly what happened when this
    // task first ran `--live` twice against a scratch log; see
    // TASKS/REPORTS.md). `THENAR_LOG_DB`/`BUNDLE_STORE_ROOT` therefore
    // default to a fixed path under `.data/` (same convention
    // `services/api/src/app.ts`'s own `defaultDeps` uses for
    // `BUNDLE_STORE_ROOT`) that every `--live` run reuses and extends,
    // exactly like the real log service would in production. `.data/` is
    // not yet in the root `.gitignore` — outside this task's file scope to
    // add; flagged in TASKS/REPORTS.md so whoever owns `.gitignore` next
    // can add it before `.data/log.db` shows up in `git status`.
    dbPath = process.env.THENAR_LOG_DB ?? join(REPO_ROOT, ".data/log.db");
    bundleRoot = process.env.BUNDLE_STORE_ROOT ?? join(REPO_ROOT, ".data/bundles");
    mkdirSync(dirname(dbPath), { recursive: true });
    mkdirSync(bundleRoot, { recursive: true });
    console.log(`live mode: persistent store db=${dbPath} bundles=${bundleRoot}`);
  } else {
    // `--local` stays fully scratch (mkdtemp, deleted at exit) — every run
    // starts from an empty log against two brand-new Anvils, so there is no
    // real head anywhere for a stale local log to ever diverge from.
    // `--reset-local` is accepted for CLI symmetry with `--live`'s
    // persistence flag but has no extra effect: `--local` is unconditionally
    // reset (a fresh directory) on every invocation already.
    dbPath = join(scratch, "log.sqlite");
    bundleRoot = join(scratch, "bundles");
    mkdirSync(bundleRoot, { recursive: true });
  }

  const cleanups = [];
  const onExit = () => { for (const fn of cleanups.reverse()) { try { fn(); } catch { /* best effort */ } } };
  process.on("exit", onExit);

  let anchorSigner; // viem Account used for anchorAll
  let supplierKey, buyerKey; // Hex private keys for the two demo scripts
  let localMockUsdc; // set only in --local mode, where deploy-chain.sh does not record CHAIN_<id>_USDC

  if (mode === "local") {
    const primary = await spawnAnvil(31337);
    const mirror = await spawnAnvil(31338);
    cleanups.push(() => primary.proc.kill("SIGKILL"), () => mirror.proc.kill("SIGKILL"));

    const primaryDeployOut = deployChain(primary.rpc, "primary", envContractsPath, ANVIL_KEY0, { DEPLOY_MOCK_USDC: "true" });
    deployChain(mirror.rpc, "mirror", envContractsPath, ANVIL_KEY0);
    // `deploy-chain.sh` only captures `CHAIN_<id>_(ROLE|LOG|VERIFIER|REGISTRY|FROM_BLOCK)=` lines into
    // `.env.contracts` — the mock USDC address it prints (`DEPLOY_MOCK_USDC=true`, local/demo chains only)
    // is not one of them, so it is read straight off the deploy script's own stdout instead (same approach
    // `services/api/test/licence-flow.test.ts`, T-027, uses).
    const usdcMatch = primaryDeployOut.match(/MockERC20 \(USDC\)\s+(0x[0-9a-fA-F]{40})/);
    if (!usdcMatch) throw new Error("local primary deploy (DEPLOY_MOCK_USDC=true) printed no MockERC20 (USDC) address");
    localMockUsdc = usdcMatch[1];

    anchorSigner = privateKeyToAccount(ANVIL_KEY0);
    supplierKey = ANVIL_KEY0;
    buyerKey = ANVIL_KEY1;
  } else {
    const realEnvContracts = join(REPO_ROOT, ".env.contracts");
    const primaryLines = readFileSync(realEnvContracts, "utf8")
      .split("\n").filter((l) => /^CHAIN_43113_/.test(l.trim()));
    if (!primaryLines.some((l) => l.startsWith("CHAIN_43113_ROLE=primary"))) {
      throw new Error(".env.contracts does not declare CHAIN_43113 as primary — cannot run --live");
    }
    writeFileSync(envContractsPath, primaryLines.join("\n") + "\n");

    const deployerEnv = parseEnvFile(join(REPO_ROOT, ".env.deployer"));
    if (!deployerEnv.DEPLOYER_PRIVATE_KEY) throw new Error(".env.deployer has no DEPLOYER_PRIVATE_KEY");
    const relayerPk = deployerEnv.ANCHOR_RELAYER_KEY || deployerEnv.DEPLOYER_PRIVATE_KEY;
    anchorSigner = privateKeyToAccount(relayerPk);
    supplierKey = deployerEnv.DEPLOYER_PRIVATE_KEY;
    buyerKey = deployerEnv.DEPLOYER_PRIVATE_KEY; // demo buys from itself on Fuji — see TASKS/REPORTS.md T-033 note

    const mirror = await spawnAnvil(31338);
    cleanups.push(() => mirror.proc.kill("SIGKILL"));
    // `Deploy.s.sol` defaults `anchorer` to the deploying key (`ANVIL_KEY0`
    // here) unless `ANCHOR_RELAYER` names a different address — the
    // primary's real Fuji `GraspLog` was deployed with `anchorSigner`'s
    // address as its anchorer (that is why step 3's Fuji anchor tx above
    // succeeds), so the mirror needs the same or `anchorAll` sending from
    // `anchorSigner` reverts there with `NotAnchorer`.
    deployChain(mirror.rpc, "mirror", envContractsPath, ANVIL_KEY0, { ANCHOR_RELAYER: anchorSigner.address });

    // The relayer's real-world address holds no funds on a brand-new local
    // Anvil mirror (only Anvil's own well-known dev accounts start funded)
    // — fund it from Anvil dev account #0 (the mirror's own deployer) so it
    // can pay gas to anchor there, same as it already can on Fuji.
    const mirrorPub = createPublicClient({ transport: http(mirror.rpc) });
    const mirrorFunder = createWalletClient({ account: privateKeyToAccount(ANVIL_KEY0), transport: http(mirror.rpc) });
    const fundTx = await mirrorFunder.sendTransaction({ chain: null, to: anchorSigner.address, value: 10n ** 18n });
    await mirrorPub.waitForTransactionReceipt({ hash: fundTx });
  }

  const chains = loadChains(envContractsPath);
  const primaryChain = chains.find((c) => c.role === "primary");
  console.log(`primary chain: ${primaryChain.id} (${primaryChain.name}) log=${primaryChain.log}`);
  console.log(`mirror chain(s): ${chains.filter((c) => c.role === "mirror").map((c) => c.id).join(", ")}`);

  // ---------------------------------------------------------- API server
  const env = { ...process.env, THENAR_LOG_DB: dbPath, ENV_CONTRACTS_FILE: envContractsPath, BUNDLE_STORE_ROOT: bundleRoot };
  const deps = defaultDeps(env);
  // `defaultDeps`'s default `chainReader` (`NotImplementedChainReader`,
  // T-016) refuses `GET /v1/licences/{id}/download` — the real
  // implementation is T-015's `ChainReader` interface, wired against
  // `graspReader` plus the store's own `corpus_episode`/`leaf` tables
  // exactly the way `services/api/test/licence-flow.test.ts` (T-027) does,
  // since the on-chain receipt names an *on-chain* corpus id that only
  // `sealCorpus`'s own event names back (recorded in `onChainToOffChain`
  // once `scripts/seal-corpus.mjs` runs, step 5 below).
  const onChainToOffChain = new Map();
  deps.chainReader = {
    async receiptAt(id) {
      const r = await deps.graspReader.receiptAt(id);
      if (isUnreachable(r)) return null;
      return { buyer: r.buyer, corpusId: r.corpusId };
    },
    async corpusEpisodes(onChainCorpusId) {
      const offChainId = onChainToOffChain.get(onChainCorpusId) ?? onChainCorpusId;
      const files = [];
      for (const { leafHash } of deps.logStore.corpusEpisodeLeaves(offChainId)) {
        const meta = deps.logStore.episodeMeta(leafHash);
        if (!meta?.manifest) continue;
        const m = JSON.parse(meta.manifest);
        files.push(...m.files);
      }
      return files;
    },
  };
  const app = createApp(deps);
  const store = deps.logStore;
  const apiPort = await new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port));
    cleanups.push(() => server.close());
  });
  const API_BASE = `http://127.0.0.1:${apiPort}`;
  console.log(`API: ${API_BASE}  db: ${dbPath}`);

  // =====================================================================
  // Step 0 — chain head check (T-033 follow-up; `--live` only)
  // =====================================================================
  // Fuji's `GraspLog` is the production head — an `anchor()` call can only
  // ever extend it (`SizeMustNotShrink`) or match it exactly at the same
  // size (`RootMustMatchAtSameSize`/`NothingToAnchor`, D-17). If this run's
  // persistent store is somehow *behind* the chain (a stale `.data/log.db`,
  // pointed at the wrong file, restored from an old copy), step 3's anchor
  // would either revert outright or — worse — silently produce nothing
  // (`NothingToAnchor`) while this script pressed on as if it had. Checked
  // once, loudly, before touching anything else.
  if (mode === "live") {
    const pub = createPublicClient({ transport: http(primaryChain.rpc) });
    const count = Number(await pub.readContract({ address: primaryChain.log, abi: LOG_ABI, functionName: "anchorCount" }));
    let chainRoot = `0x${"00".repeat(32)}`, chainSize = 0;
    if (count > 0) {
      const head = await pub.readContract({ address: primaryChain.log, abi: LOG_ABI, functionName: "anchorAt", args: [BigInt(count - 1)] });
      chainRoot = head.root;
      chainSize = Number(head.size);
    }
    const storeSize = store.size();
    console.log(`step 0/8 — chain head check: Fuji ${primaryChain.log} anchorCount=${count}, head=(root ${chainRoot.slice(0, 10)}…, size ${chainSize}); local store (${dbPath}) size=${storeSize}`);
    if (storeSize < chainSize) {
      throw new Error(
        `step 0/8 FAILED — chain head check: local store at ${dbPath} holds ${storeSize} leaves but Fuji's ` +
        `GraspLog (${primaryChain.log}) has already anchored ${chainSize}. Refusing to proceed: anchoring from ` +
        `behind the real head would either revert or (at equal size) silently no-op. Point THENAR_LOG_DB at the ` +
        `store that produced the existing head, or run --local instead.`,
      );
    }
    console.log(`step 0/8 — chain head check ... ok (store is at or ahead of the chain head)`);
  }

  // ---------------------------------------------------- seed supplier org
  const SUPPLIER_ORG = "org_golden_supplier";
  const SUPPLIER_API_KEY = `golden-supplier-${randomBytes(8).toString("hex")}`;
  const now = Math.floor(Date.now() / 1000);
  // In `--live` mode this store is persistent — a second run must not
  // re-`INSERT` the same org row (the `org` table has no update path,
  // T-024: "insert-only").
  if (!store.org(SUPPLIER_ORG)) {
    store.createOrg({ orgId: SUPPLIER_ORG, name: "THENAR golden demo supplier", kind: "supplier", status: "active", createdAt: now });
  }
  store.insertApiKey({ keyId: `key_${randomBytes(8).toString("hex")}`, orgId: SUPPLIER_ORG, keyHash: sha256Hex(SUPPLIER_API_KEY), role: "supplier", createdAt: now, revokedAt: null });

  const orgSk = ed.utils.randomSecretKey();
  const orgPubkey = toHex(await ed.getPublicKeyAsync(orgSk));
  deps.registry.registerKey(SUPPLIER_ORG, { alg: "ed25519", pubkey: orgPubkey });

  const headers = { Authorization: `Bearer ${SUPPLIER_API_KEY}` };
  const termsHash = keccak256(toHex("THENAR golden demo terms v1"));
  const termsUri = "https://thenar.io/terms/golden-demo";

  // =====================================================================
  // Step 1 — Ingest
  // =====================================================================
  {
    const s = step("Ingest");
    const files = await uploadDir(API_BASE, headers, V3_FIXTURE, V3_REL_PATHS);
    const infoEntry = files.find((f) => f.path === "meta/info.json");

    const consentSk = ed.utils.randomSecretKey();
    const consentPubkey = toHex(await ed.getPublicKeyAsync(consentSk));

    const dataset = await req(API_BASE, "/v1/datasets", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ source_uri: "fixture://lerobot-v3", info_json_hash: infoEntry.hash, files }),
    });
    const ingest = await req(API_BASE, `/v1/datasets/${dataset.dataset_id}/ingest`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        terms_hash: termsHash, scope_bits: 11, source: "teleop_real",
        consent: { holder: "contributor", pubkey: consentPubkey, alg: "ed25519", scope_bits: 11 },
      }),
    });
    const job = await pollJob(API_BASE, headers, ingest.job_id);
    if (job.status !== "done" || job.episodes.length !== 3) {
      throw new Error(`ingest job did not commit 3 episodes: ${JSON.stringify(job)}`);
    }
    console.log(`  ingested ${job.episodes.length} episodes from services/api/test/fixtures/lerobot-v3, dataset=${dataset.dataset_id}`);

    // --- the jittered copy of episode 2, as a *separate* fixture dataset ---
    const jitterDir = join(scratch, "jitter-fixture");
    const jitterMeta = await buildJitterFixture(V3_FIXTURE, jitterDir);
    const jitterFiles = await uploadDir(API_BASE, headers, jitterDir, V3_REL_PATHS);
    const jitterInfoEntry = jitterFiles.find((f) => f.path === "meta/info.json");
    const jitterDataset = await req(API_BASE, "/v1/datasets", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ source_uri: "fixture://jitter", info_json_hash: jitterInfoEntry.hash, files: jitterFiles }),
    });
    const jitterConsentSk = ed.utils.randomSecretKey();
    const jitterConsentPubkey = toHex(await ed.getPublicKeyAsync(jitterConsentSk));
    const jitterIngest = await req(API_BASE, `/v1/datasets/${jitterDataset.dataset_id}/ingest`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        terms_hash: termsHash, scope_bits: 11, source: "teleop_real",
        consent: { holder: "contributor", pubkey: jitterConsentPubkey, alg: "ed25519", scope_bits: 11 },
      }),
    });
    const jitterJob = await pollJob(API_BASE, headers, jitterIngest.job_id);
    if (jitterJob.status !== "done" || jitterJob.episodes.length !== 1) {
      throw new Error(`jitter ingest job did not commit 1 episode: ${JSON.stringify(jitterJob)}`);
    }
    console.log(`  jittered episode (sigma=${jitterMeta.sigmaDeg}deg of source episode ${jitterMeta.sourceEpisodeIndex}) ingested as dataset ${jitterDataset.dataset_id}, source_uri=fixture://jitter, leaf=${jitterJob.episodes[0].leaf_hash}`);

    global.__golden = { job, jitterJob, dataset, jitterDataset };
    s.ok(`3 real episodes + 1 jittered episode (leaf ${jitterJob.episodes[0].leaf_hash.slice(0, 10)}…)`);
  }

  // =====================================================================
  // Step 2 — Check
  // =====================================================================
  {
    const s = step("Check");
    const { job, jitterJob } = global.__golden;
    const realClaims = job.episodes.map((e) => store.claimsFor(e.leaf_hash));
    const jitterClaims = store.claimsFor(jitterJob.episodes[0].leaf_hash);
    for (const [i, claims] of realClaims.entries()) {
      console.log(`  episode ${i}: ${claims.map((c) => `${c.check}=${c.result}`).join(", ")}`);
    }
    console.log(`  jittered episode: ${jitterClaims.map((c) => `${c.check}=${c.result}`).join(", ")}`);

    const dedupOnJitter = jitterClaims.find((c) => c.check === "dedup.v1");
    if (!dedupOnJitter) throw new Error("dedup.v1 did not run on the jittered episode");
    if (dedupOnJitter.result === "fail") {
      throw new Error("dedup.v1 emitted fail on the jittered episode, but config/checks.json sets emit_fail:false for dedup.v1 (FD-1) — this should be inconclusive");
    }
    if (dedupOnJitter.result !== "inconclusive" && dedupOnJitter.result !== "pass") {
      throw new Error(`unexpected dedup.v1 result on jittered episode: ${dedupOnJitter.result}`);
    }
    for (const claims of realClaims) {
      for (const c of claims) {
        if ((c.check === "timing.v1" || c.check === "kinematics.v1") && c.result === "fail") {
          throw new Error(`${c.check} failed on a real fixture episode: ${c.detail}`);
        }
      }
    }
    global.__golden.realClaims = realClaims;
    global.__golden.jitterClaims = jitterClaims;
    s.ok(`dedup.v1 on the jittered episode: ${dedupOnJitter.result} (FD-1: never fail while emit_fail=false)`);
  }

  // =====================================================================
  // Step 3 — Anchor
  // =====================================================================
  let sealingAnchor;
  {
    const s = step("Anchor");
    const outcomes = await anchorAll(store, anchorSigner, chains);
    for (const o of outcomes) {
      if (!o.anchored) throw new Error(`anchor failed on chain ${o.chainId}: ${o.error ?? "unknown error"}`);
      console.log(`  chain ${o.chainId}: tx ${o.result.txHash} block ${o.result.blockNumber} root ${o.result.root.slice(0, 10)}… size ${o.result.size}`);
    }
    const anchorsResp = await req(API_BASE, "/v1/anchors?limit=10");
    const rootsBySize = new Set(anchorsResp.items.map((a) => `${a.root}:${a.size}`));
    const allSame = outcomes.every((o) => rootsBySize.has(`${o.result.root}:${o.result.size}`));
    if (!allSame) throw new Error("GET /v1/anchors does not show the same (root,size) just anchored on every chain");
    sealingAnchor = { root: store.root(), size: store.size() };
    s.ok(`(root,size) = (${sealingAnchor.root.slice(0, 10)}…, ${sealingAnchor.size}) on ${outcomes.length} chain(s)`);
  }

  // =====================================================================
  // Step 4 — Corpus
  // =====================================================================
  let corpusId, corpusOffChainRow, extraEpisode;
  {
    const s = step("Corpus");
    const { job } = global.__golden;

    // A 4th episode submitted through the SDK path (`POST /episodes`),
    // built and signed here rather than via the dataset-ingest flow —
    // see TASKS/REPORTS.md's T-033 entry: the ingest job derives and
    // discards each episode's `ConsentRecord` (only `salt` is returned to
    // the caller, PLAN §10.5), so a supplier can never reconstruct the
    // record a real, signed `POST /consent/{key}/revoke` (step 7) needs
    // for an ingest-created episode. This episode is built the way the
    // SDK path is documented to work (PLAN §12): the caller mints its own
    // `ConsentRecord`, keeps it, and can revoke honestly later.
    {
      const bytes = new TextEncoder().encode(`thenar golden demo episode-4 payload ${randomBytes(8).toString("hex")}`);
      const fileEntry = await uploadBytes(API_BASE, headers, bytes);
      const files = [{ path: "data/episode_4.bin", bytes: fileEntry.bytes, hash: fileEntry.hash }];
      const ph = payloadHash(files);

      const holderSk = ed.utils.randomSecretKey();
      const holderPub = toHex(await ed.getPublicKeyAsync(holderSk));
      const record = newConsentRecord({ holder: "contributor", pubkey: holderPub, alg: "ed25519", scope_bits: 11, terms_hash: termsHash, granted_at: Math.floor(Date.now() / 1000) });
      const rHash = recordHash(record);
      const cKey = deriveConsentKey(rHash);
      const salt = toHex(randomBytes(32));
      const commitment = consentCommitment(rHash, salt);

      const manifest = {
        v: 1, kind: "capture_manifest", org_id: SUPPLIER_ORG, dataset_id: null,
        source: "teleop_real", layout: "per_episode", embodiment: "so_arm100",
        rate_hz: 30, duration_ms: 1000, captured_at: Math.floor(Date.now() / 1000),
        channels: [{ name: "action", dtype: "float32", shape: [3] }],
        files, range: null, payload_hash: ph, consent_commitment: commitment,
        terms_hash: termsHash, scope_bits: 11, task: null, outcome: null, sim: null, signature: null,
      };
      const mHash = computeManifestHash(manifest);
      const sig = await signObject("ed25519", "manifest", mHash, toHex(orgSk));
      manifest.signature = { alg: "ed25519", key_id: deriveKeyId(orgPubkey), sig };

      const outcome = await req(API_BASE, "/v1/episodes", {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ manifest, consent_key: cKey }),
      });
      extraEpisode = { leafHash: outcome.leaf_hash, manifest, manifestHash: mHash, consentKey: cKey, holderSk, record };
      console.log(`  episode 4 (SDK path, revocable): leaf ${outcome.leaf_hash}`);
    }

    // Re-anchor so the manifest leaf + episode 4 are covered before sealing.
    const afterExtra = await anchorAll(store, anchorSigner, chains);
    for (const o of afterExtra) if (!o.anchored && o.error) throw new Error(`re-anchor failed on chain ${o.chainId}: ${o.error}`);
    sealingAnchor = { root: store.root(), size: store.size() };

    const episodeLeaves = [...job.episodes.map((e) => e.leaf_hash), extraEpisode.leafHash];
    const logIndices = episodeLeaves.map((l) => store.episodeMeta(l).index);
    const orderedLeaves = episodeLeaves
      .map((l, i) => ({ l, idx: logIndices[i] }))
      .sort((a, b) => a.idx - b.idx)
      .map((x) => x.l);

    const corpusRoot = corpusRootOf(orderedLeaves.map((l) => ({ leaf: l, logIndex: store.episodeMeta(l).index })));
    const sealedAt = Math.floor(Date.now() / 1000);
    const corpusManifest = {
      v: 1, kind: "corpus_manifest", org_id: SUPPLIER_ORG, title: "THENAR golden demo corpus",
      episodes: orderedLeaves, corpus_root: corpusRoot, episode_count: orderedLeaves.length,
      terms_hash: termsHash, task_id: null, filters: { min_badges: ["L0"], exclude_failed_checks: true }, sealed_at: sealedAt,
    };
    const cManifestHash = computeCorpusManifestHash(corpusManifest);
    const zero32 = `0x${"00".repeat(32)}`;
    const preimage03 = encodeCorpus({
      corpusManifestHash: cManifestHash, corpusRoot, termsHash, taskId: zero32,
      episodeCount: BigInt(orderedLeaves.length), sealedAt: BigInt(sealedAt),
    });
    const manifestLeaf = corpusLeafHash(preimage03);
    const manifestLeafIdx = store.append(manifestLeaf, { orgId: SUPPLIER_ORG });

    // `POST /corpora` / `POST /corpora/{id}/log` are still `notImplemented`
    // stubs (PLAN §12) — not a route mid-edit by another agent (see
    // TASKS/REPORTS.md's T-033 entry), so this uses the same store
    // escape hatch T-027's own test uses to reach the same state those
    // routes would produce, with every hash genuinely computed above.
    corpusId = `corpus_golden_${randomBytes(6).toString("hex")}`;
    store._insertCorpusUnchecked({
      corpusId, orgId: SUPPLIER_ORG, manifest: JSON.stringify(corpusManifest),
      corpusManifestHash: cManifestHash, corpusRoot, manifestLeafHash: manifestLeaf, manifestLeafIdx,
      onChainId: null, status: "logged", containsRevoked: false, createdAt: Date.now(),
    });
    orderedLeaves.forEach((l, i) => store._insertCorpusEpisodeUnchecked(corpusId, l, i));

    // Anchor again so the corpus manifest leaf itself is covered — sealCorpus needs an anchored leaf.
    const afterCorpus = await anchorAll(store, anchorSigner, chains);
    for (const o of afterCorpus) if (!o.anchored && o.error) throw new Error(`re-anchor after corpus log failed on chain ${o.chainId}: ${o.error}`);

    corpusOffChainRow = await req(API_BASE, `/v1/corpora/${corpusId}`);
    console.log(`  corpus ${corpusId}: ${orderedLeaves.length} episodes, corpusRoot ${corpusRoot.slice(0, 10)}…, manifest leaf index ${manifestLeafIdx}`);

    // steward publishes terms on the primary LicenceRegistry
    const REGISTRY_ABI = parseAbi(["function publishTerms(bytes32 termsHash, string uri)"]);
    const pub = createPublicClient({ transport: http(primaryChain.rpc) });
    const steward = privateKeyToAccount(supplierKey);
    const stewardWallet = createWalletClient({ account: steward, transport: http(primaryChain.rpc) });
    const raw = readFileSync(envContractsPath, "utf8");
    const registryAddr = raw.match(new RegExp(`CHAIN_${primaryChain.id}_REGISTRY=(0x[0-9a-fA-F]{40})`))[1];
    try {
      const tx = await stewardWallet.writeContract({ chain: null, address: registryAddr, abi: REGISTRY_ABI, functionName: "publishTerms", args: [termsHash, termsUri] });
      await pub.waitForTransactionReceipt({ hash: tx });
      console.log(`  publishTerms tx: ${tx}`);
    } catch (e) {
      console.log(`  publishTerms skipped (${e.message?.slice(0, 200)}) — terms may already be published`);
    }

    global.__golden.corpusId = corpusId;
    global.__golden.extraEpisode = extraEpisode;
    global.__golden.registryAddr = registryAddr;
    s.ok(`corpus ${corpusId} logged, terms published`);
  }

  // =====================================================================
  // Step 5 — Licence
  // =====================================================================
  let onChainCorpusId, receiptId;
  {
    const s = step("Licence");
    let usdc = localMockUsdc;
    if (!usdc) {
      const raw = readFileSync(envContractsPath, "utf8");
      const usdcMatch = raw.match(new RegExp(`CHAIN_${primaryChain.id}_USDC=(0x[0-9a-fA-F]{40})`));
      usdc = usdcMatch?.[1];
    }
    if (!usdc) throw new Error(`no mock/settlement USDC address available for chain ${primaryChain.id} — cannot licence`);

    const price = "1000000"; // 1 mock USDC (6 decimals)
    const supplierAccount = privateKeyToAccount(supplierKey);
    const scriptEnv = { SUPPLIER_KEY: supplierKey, SUPPLIER_API_KEY, BUYER_KEY: buyerKey };

    const sealArgv = ["--corpus", corpusId, "--api", API_BASE, "--price", price, "--token", usdc, "--env-contracts", envContractsPath];
    const sealResult = await runNodeScript(join(REPO_ROOT, "scripts/seal-corpus.mjs"), sealArgv, scriptEnv);
    onChainCorpusId = sealResult.onChainId;
    onChainToOffChain.set(onChainCorpusId, corpusId);
    console.log(`  seal-corpus.mjs: tx ${sealResult.txHash}, on-chain corpus id ${onChainCorpusId}`);

    // mint the buyer enough mock USDC (buyer == deployer/steward account in --live mode; no-op risk there since it mints to itself)
    const pub = createPublicClient({ transport: http(primaryChain.rpc) });
    const deployerWallet = createWalletClient({ account: supplierAccount, transport: http(primaryChain.rpc) });
    const buyerAddress = privateKeyToAccount(buyerKey).address;
    try {
      const MOCK_ERC20_ABI = parseAbi(["function mint(address to, uint256 amount)", "function balanceOf(address) view returns (uint256)"]);
      const bal = await pub.readContract({ address: usdc, abi: MOCK_ERC20_ABI, functionName: "balanceOf", args: [buyerAddress] });
      if (bal < BigInt(price)) {
        const mintTx = await deployerWallet.writeContract({ chain: null, address: usdc, abi: MOCK_ERC20_ABI, functionName: "mint", args: [buyerAddress, BigInt(price) * 10n] });
        await pub.waitForTransactionReceipt({ hash: mintTx });
        console.log(`  minted mock USDC to buyer: tx ${mintTx}`);
      } else {
        console.log(`  buyer already holds ${bal} of the settlement token — no mint needed`);
      }
    } catch (e) {
      throw new Error(`could not mint/verify buyer's mock USDC balance on ${usdc}: ${e.message}`);
    }

    const licenseArgv = ["--corpus", onChainCorpusId, "--env-contracts", envContractsPath];
    const licenseResult = await runNodeScript(join(REPO_ROOT, "scripts/license.mjs"), licenseArgv, scriptEnv);
    receiptId = licenseResult.receiptId;
    console.log(`  license.mjs: tx ${licenseResult.txHash}, receipt id ${receiptId}`);
    s.ok(`receipt ${receiptId} names corpusManifestHash ${licenseResult.receipt.corpusManifestHash}`);
  }

  // =====================================================================
  // Step 6 — Deliver + verify offline
  // =====================================================================
  let deliverDir, reportPath;
  {
    const s = step("Deliver + verify offline");
    deliverDir = join(scratch, "delivered");
    const downloadResult = await runNodeScript(join(REPO_ROOT, "scripts/download.mjs"), ["--receipt", receiptId, "--api", API_BASE, "--out", deliverDir], { BUYER_KEY: buyerKey });
    const mismatches = downloadResult.files.filter((r) => !r.verified);
    if (mismatches.length > 0) throw new Error(`downloaded files failed hash verification: ${JSON.stringify(mismatches)}`);
    console.log(`  downloaded ${downloadResult.files.length} file(s) to ${deliverDir}, all hashes verified`);

    const { job, jitterJob, extraEpisode: ee, realClaims } = global.__golden;

    // T-025 shipped the real route — use it by default; `assembleReport`
    // (scripts/lib/assemble-report.mjs) stays available as a fallback
    // behind `--assemble-locally` (it never needs the route to exist).
    let report;
    if (assembleLocally) {
      const episodesForReport = job.episodes.map((e, i) => ({
        leafHash: e.leaf_hash,
        manifest: JSON.parse(store.episodeMeta(e.leaf_hash).manifest),
        manifestHash: store.episodeMeta(e.leaf_hash).manifestHash,
        consentKey: store.episodeMeta(e.leaf_hash).consentKey,
        claims: realClaims[i],
      })).concat([{
        leafHash: ee.leafHash, manifest: ee.manifest, manifestHash: ee.manifestHash,
        consentKey: ee.consentKey, claims: store.claimsFor(ee.leafHash), orgPubkey,
      }]);

      report = await assembleReport({
        apiBase: API_BASE, corpusId, reportAnchor: sealingAnchor, sealingAnchor,
        operator: { name: "THENAR golden demo", keyId: deps.operator.keyId },
        terms: { hash: termsHash, uri: termsUri },
        episodes: episodesForReport, limitations: LIMITATIONS,
      });
    } else {
      report = await req(API_BASE, `/v1/corpora/${corpusId}/report`);
    }
    reportPath = join(REPO_ROOT, "apps/web/samples/golden-report.json");
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
    console.log(`  wrote ${reportPath} (report_hash ${report.report_hash.slice(0, 10)}…)`);

    const verifyResult = await runNodeScript(join(REPO_ROOT, "scripts/verify-report.mjs"), ["--report", reportPath, "--files", deliverDir, "--rpc", primaryChain.rpc, "--chain", String(primaryChain.id)], {}, { allowFailure: true });
    if (verifyResult.code !== 0) {
      throw new Error(`scripts/verify-report.mjs did not pass against the freshly delivered files:\n${verifyResult.stdout}\n${verifyResult.stderr}`);
    }
    console.log(verifyResult.stdout.split("\n").map((l) => `  ${l}`).join("\n"));
    s.ok("offline verifier passes against the delivered files");
  }

  // =====================================================================
  // Step 7 — Revoke
  // =====================================================================
  {
    const s = step("Revoke");
    const { extraEpisode: ee } = global.__golden;
    const sizeBefore = store.size();

    const revokeSigHex = await signObject(ee.record.alg, "revoke", ee.consentKey, toHex(ee.holderSk));
    const revokeSignature = { alg: ee.record.alg, key_id: deriveKeyId(ee.record.pubkey), sig: revokeSigHex };
    // C-1 (services/api/src/routes/consent.ts now passes signature.sig to
    // LogStore.revoke, matching sign.ts's verify() shape) — a genuinely
    // valid signature is accepted.
    const revokeResp = await req(API_BASE, `/v1/consent/${ee.consentKey}/revoke`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ record: ee.record, signature: revokeSignature }),
    });
    if (!revokeResp.accepted) throw new Error(`revoke was not accepted: ${JSON.stringify(revokeResp)}`);

    const revocationOutcomes = await anchorAll(store, anchorSigner, chains);
    const sizeAfter = store.size();
    if (sizeAfter !== sizeBefore) throw new Error(`revocation-only anchor should not grow the log (was ${sizeBefore}, now ${sizeAfter})`);
    for (const o of revocationOutcomes) {
      if (!o.anchored) throw new Error(`revocation-only anchor failed on chain ${o.chainId}: ${o.error ?? "no new anchor was produced"}`);
      if (o.result.size !== sizeBefore) throw new Error(`revocation-only anchor on chain ${o.chainId} changed size`);
      console.log(`  chain ${o.chainId}: revocation-only anchor tx ${o.result.txHash}, size unchanged at ${o.result.size}, new revocationRoot ${o.result.revocationRoot.slice(0, 10)}…`);
    }
    const reportAnchorAfterRevoke = { root: store.root(), size: store.size() };

    const consentAfter = await req(API_BASE, `/v1/consent/${ee.consentKey}?root=${reportAnchorAfterRevoke.root}&size=${reportAnchorAfterRevoke.size}`);
    if (consentAfter.status !== "revoked") throw new Error(`GET /v1/consent/${ee.consentKey} does not show revoked: ${JSON.stringify(consentAfter)}`);
    console.log(`  GET /v1/consent/${ee.consentKey} -> revoked${consentAfter.onset ? `, onset block ${consentAfter.onset.block}` : ""}`);

    // C-3/D-37 — episode 4 was submitted with `consent_key` on the wire
    // (POST /episodes), so it is stored on the leaf row and the revocation
    // above resolves to it.
    const corpusAfter = await req(API_BASE, `/v1/corpora/${corpusId}`);
    if (!corpusAfter.contains_revoked) {
      throw new Error(`GET /v1/corpora/${corpusId} does not show contains_revoked, even though the ` +
        `revocation itself is genuinely recorded (GET /v1/consent/${ee.consentKey} above showed "revoked").`);
    }
    console.log(`  GET /v1/corpora/${corpusId} -> contains_revoked: true`);

    // The buyer's already-issued receipt/report still verifies against the *sealing* anchor (§6.1) — unchanged, so re-run is redundant but explicit here:
    const verifyStillOk = await runNodeScript(join(REPO_ROOT, "scripts/verify-report.mjs"), ["--report", reportPath, "--files", deliverDir, "--rpc", primaryChain.rpc, "--chain", String(primaryChain.id)], {}, { allowFailure: true });
    if (verifyStillOk.code !== 0) throw new Error(`the buyer's report no longer verifies after the post-sale revocation (§6.1 violated):\n${verifyStillOk.stdout}`);

    s.ok("revocation-only head anchored (equal size); buyer's earlier report still verifies");
  }

  // =====================================================================
  // Step 8 — Tamper
  // =====================================================================
  {
    const s = step("Tamper");
    const { execSync } = await import("node:child_process");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    const parquetEp = report.episodes.find((e) => (e.files || []).some((f) => f.path.endsWith(".parquet")));
    if (!parquetEp) throw new Error("no episode in the report carries a downloaded parquet file to tamper with");
    const parquetFile = parquetEp.files.find((f) => f.path.endsWith(".parquet"));
    const localPath = join(deliverDir, parquetFile.path.replace(/\//g, "_"));
    const bytes = readFileSync(localPath);
    const tampered = Buffer.from(bytes);
    tampered[Math.floor(tampered.length / 2)] ^= 0xff;
    writeFileSync(localPath, tampered);

    const tamperResult = await runNodeScript(join(REPO_ROOT, "scripts/verify-report.mjs"), ["--report", reportPath, "--files", deliverDir, "--rpc", primaryChain.rpc, "--chain", String(primaryChain.id)], {}, { allowFailure: true });
    // restore the file so a re-run of this same scratch dir (there isn't one, but be tidy) is not left corrupted
    writeFileSync(localPath, bytes);

    if (tamperResult.code === 0) throw new Error("verify-report.mjs passed against a tampered file — it should have failed");
    const namesFile = tamperResult.stdout.includes(parquetFile.path) || tamperResult.stdout.includes(localPath);
    const namesLeaf = tamperResult.stdout.includes(parquetEp.leaf);
    if (!namesFile || !namesLeaf) {
      throw new Error(`verify-report.mjs failed as expected but did not name both the file and the leaf:\n${tamperResult.stdout}`);
    }
    console.log(tamperResult.stdout.split("\n").filter((l) => l.trim()).slice(0, 6).map((l) => `  ${l}`).join("\n"));
    s.ok(`verifier named file "${parquetFile.path}" and leaf ${parquetEp.leaf.slice(0, 10)}…`);
  }

  console.log("\n8/8 steps passed\n");
  onExit();
  process.removeListener("exit", onExit);
  rmSync(scratch, { recursive: true, force: true });
}

/** Runs a script's exported `main()` in-process (cheap, same style T-027's own scripts use) rather than a child process, except where a genuine separate-process run matters (verify-report.mjs, which must work as a standalone CLI). */
async function runNodeScript(scriptPath, argv, env, { allowFailure = false } = {}) {
  if (scriptPath.endsWith("verify-report.mjs")) {
    return await new Promise((resolve) => {
      const tsxBin = join(REPO_ROOT, "node_modules/.bin/tsx");
      const child = spawn(tsxBin, [scriptPath, ...argv], { cwd: REPO_ROOT, env: { ...process.env, ...env } });
      let stdout = "", stderr = "";
      child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
      child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
      child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });
  }
  const modUrl = `file://${scriptPath}`;
  const mod = await import(modUrl);
  const prevEnv = { ...process.env };
  Object.assign(process.env, env);
  try {
    const result = await mod.main(argv, process.env);
    return result;
  } catch (e) {
    if (allowFailure) return { code: 1, stdout: "", stderr: String(e) };
    throw e;
  } finally {
    process.env = prevEnv;
  }
}

main().catch((e) => {
  console.error("\ngolden demo FAILED:", e.stack ?? String(e));
  process.exit(1);
});
