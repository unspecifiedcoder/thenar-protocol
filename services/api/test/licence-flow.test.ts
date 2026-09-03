/**
 * `services/api/test/licence-flow.test.ts` — T-027, PLAN §21 golden demo
 * steps 4-6 end to end against a real Anvil chain (D-9's primary role) and
 * a real, in-process log API server:
 *
 *  1. Deploy `GraspLog`/`LeafVerifier`/`LicenceRegistry` + `MockERC20`
 *     (T-006) via `forge script` with `DEPLOY_MOCK_USDC=true` (this task's
 *     supervisor note — no live chain to prove the scripts against).
 *  2. Seed a corpus row + its 0x03 manifest leaf directly through the store
 *     (`_insertCorpusUnchecked`, T-016's escape hatch — `POST /corpora`'s
 *     own pipeline is a different task's concern), anchor the log with the
 *     Anvil deployer key (the anchorer, by `Deploy.s.sol`'s default), and
 *     publish terms as the registry's steward (same key).
 *  3. Run `scripts/seal-corpus.mjs`, `scripts/license.mjs` and
 *     `scripts/download.mjs` as real child processes (as PLAN §25.2 /
 *     T-027's binding rule requires) against the running API and the
 *     Anvil RPC, and assert the receipt fields and downloaded file hashes.
 *
 * Needs `anvil` and `forge` on PATH — skipped loudly, not silently green,
 * if either is missing (same convention as `chain.test.ts`).
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync as readFileSyncFs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { createPublicClient, createWalletClient, http, parseAbi, keccak256, toHex, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { createApp, type Deps } from "../src/app.ts";
import { KeyStore, type ApiKeyRecord, sha256Hex } from "../src/auth.ts";
import { MemoryIdempotencyStore } from "../src/idempotency.ts";
import { TokenBucketLimiter } from "../src/ratelimit.ts";
import { LocalBundleStore } from "../src/store/localBundleStore.ts";
import { MemoryUploadRegistry } from "../src/store/uploadRegistry.ts";
import { Registry } from "../src/registry.ts";
import { ViemChainReader, loadChainReaderTargets, isUnreachable } from "../src/chain.ts";
import type { ChainReader, ReceiptInfo, CorpusFile } from "../src/chainReader.ts";
import { LogStore } from "../../log/src/store.ts";
import { corpusManifestHash as computeCorpusManifestHash, corpusRootOf } from "../../../packages/protocol/src/mapping.ts";
import { encodeCorpus, corpusLeafHash } from "../../../packages/protocol/src/corpus.ts";
import type { CorpusManifest } from "../../../packages/protocol/src/schemas.ts";

let fails = 0;
const ok = (c: boolean, m: string, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };

function haveBinary(name: string): boolean {
  try {
    execFileSync(name, ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// `--port 0` (both anvil and the API server) rather than a fixed port: this
// checkout is shared with other agents, and this exact file also runs as
// part of `pnpm test:api`, which another concurrent agent may be running at
// the same time — a hard-coded port is a guaranteed `EADDRINUSE` race.
// Anvil's well-known dev-account keys (same set `chain.test.ts` and
// `deploy:anvil` use) — deployer/anchorer/steward is #0, buyer is #1, no
// funded key needed from the environment.
const DEPLOYER_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;
const BUYER_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex;

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

/** Spawns `anvil --port 0` and reads the OS-assigned port back off its own "Listening on" line — never guessed, never a fixed port two concurrent runs could collide on. */
async function spawnAnvil(timeoutMs = 20_000): Promise<{ proc: ChildProcessWithoutNullStreams; rpc: string }> {
  const proc = spawn("anvil", ["--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
  const port = await new Promise<number>((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const m = buf.match(/Listening on 127\.0\.0\.1:(\d+)/);
      if (m) { cleanup(); resolve(Number(m[1])); }
    };
    const onErr = (e: unknown) => { cleanup(); reject(e); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("anvil did not report a listening port in time")); }, timeoutMs);
    const cleanup = () => { clearTimeout(timer); proc.stdout.off("data", onData); proc.off("error", onErr); };
    proc.stdout.on("data", onData);
    proc.on("error", onErr);
  });
  const rpc = `http://127.0.0.1:${port}`;
  await waitForRpc(rpc, timeoutMs);
  return { proc, rpc };
}

async function waitForRpc(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr: unknown;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      });
      if (res.ok) return;
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`anvil did not answer at ${url} within ${timeoutMs}ms: ${lastErr}`);
}

/**
 * Runs a script as a child process and waits for it — with `spawn`, not
 * `spawnSync`. The scripts under test call back into this same process's
 * own in-process API server (`apiServer` below); `spawnSync` blocks this
 * process's entire event loop until the child exits, which would freeze
 * that very server and deadlock the child against its own parent. `spawn`
 * keeps the event loop (and the server) running while the child works.
 */
function runScript(scriptPath: string, args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", scriptPath, ...args], {
      cwd, env: { ...process.env, ...env },
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString("utf8"); });
    child.stderr.on("data", (d) => { stderr += d.toString("utf8"); });
    child.on("close", (code) => resolve({ status: code ?? 1, stdout, stderr }));
  });
}

async function main() {
  if (!haveBinary("anvil") || !haveBinary("forge")) {
    console.log("SKIP services/api/test/licence-flow.test.ts — anvil/forge not found on PATH (T-027 needs both)");
    return;
  }

  let anvil: ChildProcessWithoutNullStreams | undefined;
  let apiServer: ReturnType<typeof serve> | undefined;
  const envDir = mkdtempSync(join(tmpdir(), "thenar-licence-test-"));
  const envFile = join(envDir, ".env.contracts");
  const bundleDir = mkdtempSync(join(tmpdir(), "thenar-licence-bundles-"));

  try {
    const anvilHandle = await spawnAnvil();
    anvil = anvilHandle.proc;
    const ANVIL_RPC = anvilHandle.rpc;

    // ------------------------------------------------------------- deploy
    const deployOut = execFileSync(
      "bash", ["scripts/deploy-chain.sh", ANVIL_RPC, "primary", "none", DEPLOYER_KEY],
      { cwd: REPO_ROOT, env: { ...process.env, ENV_CONTRACTS_FILE: envFile, DEPLOY_MOCK_USDC: "true" }, encoding: "utf8" },
    );
    const mockUsdcMatch = deployOut.match(/MockERC20 \(USDC\)\s+(0x[0-9a-fA-F]{40})/);
    ok(!!mockUsdcMatch, "deploy printed a MockERC20 (USDC) address", deployOut.slice(-400));
    const mockUsdc = mockUsdcMatch![1] as Hex;

    const targets = loadChainReaderTargets(envFile);
    ok(targets.length === 1 && targets[0]!.role === "primary", "one primary chain target loaded");
    ok(!!targets[0]!.registry, "the deploy recorded a LicenceRegistry address");
    const registry = targets[0]!.registry as Hex;

    const pub = createPublicClient({ transport: http(ANVIL_RPC) });
    const deployer = privateKeyToAccount(DEPLOYER_KEY);
    const deployerWallet = createWalletClient({ account: deployer, transport: http(ANVIL_RPC) });
    const buyer = privateKeyToAccount(BUYER_KEY);

    // --------------------------------------------------------- seed the log
    const logStore = new LogStore(":memory:");

    const fileBytes = new TextEncoder().encode("thenar licence-flow fixture episode payload");
    const fileHash = keccak256(fileBytes);
    writeFileSync(join(bundleDir, fileHash.toLowerCase()), fileBytes);

    const episodeLeaf = keccak256(toHex("episode-fixture-0")) as Hex;
    logStore.append(episodeLeaf, {
      orgId: "org_supplier",
      manifest: JSON.stringify({ files: [{ path: "data/episode_0.parquet", hash: fileHash, bytes: fileBytes.length }] }),
    });

    const corpusRoot = corpusRootOf([{ leaf: episodeLeaf, logIndex: 0 }]);
    const termsHash = keccak256(toHex("thenar licence-flow terms fixture")) as Hex;
    const sealedAt = Math.floor(Date.now() / 1000);
    const manifest: CorpusManifest = {
      v: 1, kind: "corpus_manifest", org_id: "org_supplier", title: "licence-flow fixture corpus",
      episodes: [episodeLeaf], corpus_root: corpusRoot, episode_count: 1, terms_hash: termsHash,
      task_id: null, filters: {}, sealed_at: sealedAt,
    };
    const cManifestHash = computeCorpusManifestHash(manifest);
    const zero32 = ("0x" + "00".repeat(32)) as Hex;
    const preimage03 = encodeCorpus({
      corpusManifestHash: cManifestHash, corpusRoot, termsHash, taskId: zero32,
      episodeCount: 1n, sealedAt: BigInt(sealedAt),
    });
    const manifestLeaf = corpusLeafHash(preimage03);
    const manifestLeafIdx = logStore.append(manifestLeaf, { orgId: "org_supplier" });

    logStore._insertCorpusUnchecked({
      corpusId: "corpus_1", orgId: "org_supplier", manifest: JSON.stringify(manifest),
      corpusManifestHash: cManifestHash, corpusRoot, manifestLeafHash: manifestLeaf, manifestLeafIdx,
      onChainId: null, status: "logged", containsRevoked: false, createdAt: Date.now(),
    });
    logStore._insertCorpusEpisodeUnchecked("corpus_1", episodeLeaf, 0);

    // ------------------------------------------------------------- anchor
    const LOG_ABI = parseAbi(["function anchor(bytes32 root, uint64 size, bytes32 revocationRoot) returns (uint256)"]);
    const revocationRoot = zero32;
    const root = logStore.root();
    const size = logStore.size();
    const anchorTx = await deployerWallet.writeContract({
      chain: null, address: targets[0]!.log, abi: LOG_ABI, functionName: "anchor", args: [root, BigInt(size), revocationRoot],
    });
    const anchorReceipt = await pub.waitForTransactionReceipt({ hash: anchorTx });
    ok(anchorReceipt.status === "success", "anchor tx succeeded");
    logStore.recordAnchor(0, root, size, revocationRoot, anchorTx, Number(anchorReceipt.blockNumber));
    logStore.recordAnchorChain(targets[0]!.id, 0, root, size, revocationRoot, anchorTx, Number(anchorReceipt.blockNumber));

    // --------------------------------------------------------- publish terms
    const REGISTRY_ABI = parseAbi([
      "function publishTerms(bytes32 termsHash, string uri)",
    ]);
    const publishTx = await deployerWallet.writeContract({
      chain: null, address: registry, abi: REGISTRY_ABI, functionName: "publishTerms",
      args: [termsHash, "https://example.invalid/terms"],
    });
    const publishReceipt = await pub.waitForTransactionReceipt({ hash: publishTx });
    ok(publishReceipt.status === "success", "publishTerms tx succeeded");

    // ------------------------------------------------------------- API server
    const SUPPLIER_KEY = "licence-flow-supplier-key";
    const apiKeys: ApiKeyRecord[] = [{ key_sha256: sha256Hex(SUPPLIER_KEY), org_id: "org_supplier", role: "supplier" }];
    const graspReader = new ViemChainReader(targets);

    // The download route's `ChainReader` (T-015's interface) needs a
    // receipt -> corpus-episode-files mapping; the on-chain corpus id is
    // learned only after `sealCorpus` runs (below), so this map is filled
    // in once and the closure reads it lazily.
    const onChainToOffChain = new Map<string, string>();
    const testChainReader: ChainReader = {
      async receiptAt(id: string): Promise<ReceiptInfo | null> {
        const r = await graspReader.receiptAt(id);
        if (isUnreachable(r)) return null;
        return { buyer: r.buyer, corpusId: r.corpusId };
      },
      async corpusEpisodes(corpusId: string): Promise<CorpusFile[]> {
        const offChainId = onChainToOffChain.get(corpusId) ?? corpusId;
        const files: CorpusFile[] = [];
        for (const { leafHash } of logStore.corpusEpisodeLeaves(offChainId)) {
          const meta = logStore.episodeMeta(leafHash);
          if (!meta?.manifest) continue;
          const m = JSON.parse(meta.manifest) as { files: CorpusFile[] };
          files.push(...m.files);
        }
        return files;
      },
    };

    const deps: Deps = {
      keyStore: new KeyStore(apiKeys),
      idempotencyStore: new MemoryIdempotencyStore(),
      rateLimiter: new TokenBucketLimiter(),
      nowMinute: () => Math.floor(Date.now() / 60_000),
      bundleStore: new LocalBundleStore(bundleDir),
      uploadRegistry: new MemoryUploadRegistry(),
      chainReader: testChainReader,
      registry: new Registry(logStore),
      logStore,
      graspReader,
    };
    const app = createApp(deps);
    const apiPort = await new Promise<number>((resolve) => {
      apiServer = serve({ fetch: app.fetch, port: 0 }, (info) => resolve(info.port));
    });
    const API_BASE = `http://127.0.0.1:${apiPort}`;
    await new Promise((r) => setTimeout(r, 300));

    // -------------------------------------------------- GET seal-params (route)
    {
      const price = "1000000"; // 1 mUSDC (6 decimals)
      const res = await fetch(
        `${API_BASE}/v1/corpora/corpus_1/seal-params?price=${price}&token=${mockUsdc}&supplier=${deployer.address}`,
        { headers: { Authorization: `Bearer ${SUPPLIER_KEY}` } },
      );
      ok(res.status === 200, "GET /v1/corpora/corpus_1/seal-params -> 200", String(res.status));
      const body = await res.json();
      ok(body.seal_params?.corpusManifestHash === cManifestHash, "seal_params.corpusManifestHash matches");
      ok(body.leaf_index === manifestLeafIdx, "leaf_index matches the stored manifest leaf index");
      ok(Array.isArray(body.anchor?.chains) && body.anchor.chains.length === 1, "seal-params names the anchor's chains");
    }

    // ----------------------------------------------------- scripts/seal-corpus.mjs
    const scriptEnv = { SUPPLIER_KEY: DEPLOYER_KEY, SUPPLIER_API_KEY: SUPPLIER_KEY, BUYER_KEY };
    const sealResult = await runScript(
      join(REPO_ROOT, "scripts/seal-corpus.mjs"),
      ["--corpus", "corpus_1", "--api", API_BASE, "--price", "1000000", "--token", mockUsdc, "--env-contracts", envFile],
      scriptEnv, REPO_ROOT,
    );
    ok(sealResult.status === 0, "scripts/seal-corpus.mjs exits 0", sealResult.stderr.slice(-800));
    const onChainIdMatch = sealResult.stdout.match(/on-chain corpus id: (\d+)/);
    ok(!!onChainIdMatch, "scripts/seal-corpus.mjs printed the on-chain corpus id", sealResult.stdout);
    const onChainCorpusId = onChainIdMatch ? onChainIdMatch[1] : "0";
    onChainToOffChain.set(onChainCorpusId, "corpus_1");

    // -------------------------------------------------------- GET .../onchain
    {
      const res = await fetch(`${API_BASE}/v1/corpora/corpus_1/onchain`);
      ok(res.status === 200, "GET /v1/corpora/corpus_1/onchain -> 200", String(res.status));
      const body = await res.json();
      ok(body.on_chain_id === onChainCorpusId, "onchain lookup finds the corpus by corpusManifestHash", `${body.on_chain_id} vs ${onChainCorpusId}`);
    }

    // ---------------------------------------------------------- mint buyer USDC
    const MOCK_ERC20_ABI = parseAbi(["function mint(address to, uint256 amount)"]);
    const mintTx = await deployerWallet.writeContract({
      chain: null, address: mockUsdc, abi: MOCK_ERC20_ABI, functionName: "mint", args: [buyer.address, 1_000_000n],
    });
    await pub.waitForTransactionReceipt({ hash: mintTx });

    // -------------------------------------------------------- scripts/license.mjs
    const licenseResult = await runScript(
      join(REPO_ROOT, "scripts/license.mjs"),
      ["--corpus", onChainCorpusId, "--env-contracts", envFile],
      scriptEnv, REPO_ROOT,
    );
    ok(licenseResult.status === 0, "scripts/license.mjs exits 0", licenseResult.stderr.slice(-800));
    ok(/corpusManifestHash\s+0x/.test(licenseResult.stdout), "scripts/license.mjs prints the receipt fields");
    ok(licenseResult.stdout.includes(cManifestHash), "the printed receipt names this corpus's manifest hash");
    const receiptIdMatch = licenseResult.stdout.match(/receipt id: (\d+)/);
    ok(!!receiptIdMatch, "scripts/license.mjs printed a receipt id", licenseResult.stdout);
    const receiptId = receiptIdMatch ? receiptIdMatch[1] : "0";

    // ------------------------------------------------------- scripts/download.mjs
    const outDir = mkdtempSync(join(tmpdir(), "thenar-licence-download-"));
    const downloadResult = await runScript(
      join(REPO_ROOT, "scripts/download.mjs"),
      ["--receipt", receiptId, "--api", API_BASE, "--out", outDir],
      scriptEnv, REPO_ROOT,
    );
    ok(downloadResult.status === 0, "scripts/download.mjs exits 0", downloadResult.stderr.slice(-800));
    ok(downloadResult.stdout.includes("ok") && !downloadResult.stdout.includes("MISMATCH"), "downloaded file's hash verified, no mismatch");
    const downloaded = readFileSyncFs(join(outDir, "data_episode_0.parquet"));
    ok(keccak256(downloaded) === fileHash, "the downloaded bytes hash to the manifest's recorded hash");
    rmSync(outDir, { recursive: true, force: true });
  } finally {
    anvil?.kill("SIGKILL");
    apiServer?.close();
    rmSync(envDir, { recursive: true, force: true });
    rmSync(bundleDir, { recursive: true, force: true });
  }
}

await main();

if (fails > 0) {
  console.log(`\n${fails} licence-flow test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall licence-flow tests passed");
}
