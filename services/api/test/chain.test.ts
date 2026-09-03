/**
 * `services/api/src/chain.ts` — T-016 (D-29, PLAN §15). Real reads against
 * an Anvil chain running `Deploy.s.sol`: `anchorCount`/`anchorAt`/
 * `indexOfRoot` through `ViemChainReader`, the 15 s cache's `stale_at`
 * behaviour under a fake clock, and an `unreachable` result when pointed at
 * a dead port. No test framework, plain boolean assertions, matching the
 * rest of `services/api/test`.
 *
 * Needs `anvil` and `forge` on PATH (both installed here, T-009's own
 * `deploy:anvil` already depends on them) — if either is missing, every
 * assertion below is skipped loudly rather than silently reporting green.
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWalletClient, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ViemChainReader, loadChainReaderTargets, isUnreachable } from "../src/chain.ts";

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

const ANVIL_PORT = 8598;
const ANVIL_RPC = `http://127.0.0.1:${ANVIL_PORT}`;
// Anvil's well-known first dev-account key (same one `deploy:anvil` uses, root package.json) — no funded key needed.
const ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as Hex;

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

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

async function main() {
  if (!haveBinary("anvil") || !haveBinary("forge")) {
    console.log("SKIP services/api/test/chain.test.ts — anvil/forge not found on PATH (T-016 needs both)");
    return;
  }

  let anvil: ChildProcessWithoutNullStreams | undefined;
  const envDir = mkdtempSync(join(tmpdir(), "thenar-chain-test-"));
  const envFile = join(envDir, ".env.contracts");

  try {
    anvil = spawn("anvil", ["--port", String(ANVIL_PORT), "--silent"], { stdio: "ignore" });
    await waitForRpc(ANVIL_RPC);

    // Deploy GraspLog + LeafVerifier + LicenceRegistry (D-9: primary deploys all three)
    // straight to a scratch `.env.contracts`, never the real one.
    execFileSync("bash", ["scripts/deploy-chain.sh", ANVIL_RPC, "primary", "none", ANVIL_KEY], {
      cwd: REPO_ROOT, env: { ...process.env, ENV_CONTRACTS_FILE: envFile }, stdio: "pipe",
    });

    const targets = loadChainReaderTargets(envFile);
    ok(targets.length === 1, "one chain target loaded from the deploy", String(targets.length));
    ok(targets[0]?.role === "primary", "the deployed chain is primary");
    ok(!!targets[0]?.registry, "the deploy recorded a LicenceRegistry address");

    // ------------------------------------------------------------- anchorCount == 0
    {
      const reader = new ViemChainReader(targets);
      const r = await reader.anchorCount();
      ok(!isUnreachable(r), "anchorCount reachable before any anchor");
      if (!isUnreachable(r)) ok(r.count === 0, "anchorCount is 0 before any anchor", String(r.count));
    }

    // --------------------------------------------------------- anchor once, then read it back
    const LOG_ABI = parseAbi([
      "function anchor(bytes32 root, uint64 size, bytes32 revocationRoot) returns (uint256)",
    ]);
    const account = privateKeyToAccount(ANVIL_KEY);
    const wallet = createWalletClient({ account, transport: http(ANVIL_RPC) });
    const root = ("0x" + "11".repeat(32)) as Hex;
    const revocationRoot = ("0x" + "00".repeat(32)) as Hex;

    const txHash = await wallet.writeContract({
      chain: null, address: targets[0]!.log, abi: LOG_ABI, functionName: "anchor",
      args: [root, 1n, revocationRoot],
    });
    // Anvil (non-instamine off) mines immediately by default; poll the receipt via anchorCount instead of a public client.
    {
      const deadline = Date.now() + 10_000;
      let count = 0;
      const reader = new ViemChainReader(targets);
      while (Date.now() < deadline) {
        const r = await reader.anchorCount();
        if (!isUnreachable(r) && r.count > 0) { count = r.count; break; }
        await new Promise((res) => setTimeout(res, 200));
      }
      ok(count === 1, "anchorCount is 1 after one anchor tx", `tx ${txHash}, count ${count}`);
    }

    {
      const reader = new ViemChainReader(targets);
      const at = await reader.anchorAt(0);
      ok(!isUnreachable(at), "anchorAt(0) reachable");
      if (!isUnreachable(at)) {
        ok(at.root === root, "anchorAt(0).root matches the anchored root");
        ok(at.size === 1, "anchorAt(0).size matches the anchored size");
        ok(typeof at.stale_at === "number" && at.stale_at > Date.now() - 1000, "anchorAt(0) carries a future stale_at");
      }

      const idx = await reader.indexOfRoot(root);
      ok(!isUnreachable(idx), "indexOfRoot reachable");
      if (!isUnreachable(idx)) {
        ok(idx.found === true, "indexOfRoot finds the anchored root");
        ok(idx.index === 0, "indexOfRoot reports index 0");
      }

      const onChain = await reader.anchorAtOnChain(targets[0]!.id, 0);
      ok(!isUnreachable(onChain), "anchorAtOnChain(primary, 0) reachable");
      if (!isUnreachable(onChain)) ok(onChain.root === root, "anchorAtOnChain(primary, 0) matches");
    }

    // ------------------------------------------------------- LicenceRegistry primary-only reads
    {
      const reader = new ViemChainReader(targets);
      // `LicenceRegistry.termsAt` reverts `UnknownTerms` for a hash nobody published
      // (`packages/contracts/src/LicenceRegistry.sol`) rather than returning `exists:
      // false` — `readRegistry` folds that into `unreachable` the same as any other
      // failed call, so this is exercising "the call did not succeed", not literally
      // a downed RPC.
      const terms = await reader.termsAt(("0x" + "22".repeat(32)) as Hex);
      ok(isUnreachable(terms), "termsAt on an unpublished termsHash does not fabricate a Terms row");

      const receipts = await reader.receiptsOf(("0x" + "00".repeat(20)) as Hex);
      ok(!isUnreachable(receipts), "receiptsOf reachable");
      if (!isUnreachable(receipts)) ok(receipts.ids.length === 0, "the zero address holds no receipts");
    }

    // ---------------------------------------------------------------- cache / stale_at
    {
      let now = 1_000_000;
      const reader = new ViemChainReader(targets, () => now);

      const first = await reader.anchorCount();
      ok(!isUnreachable(first), "cache test: first read reachable");
      if (isUnreachable(first)) throw new Error("unreachable");
      ok(first.stale_at === now + 15_000, "stale_at is fetch time + 15s", String(first.stale_at));

      // Anchor a second time on-chain, but stay inside the 15s window — the reader must
      // still answer from cache (D-29: a cache hit never re-hits the RPC mid-window).
      await wallet.writeContract({
        chain: null, address: targets[0]!.log, abi: LOG_ABI, functionName: "anchor",
        args: [("0x" + "33".repeat(32)) as Hex, 2n, revocationRoot],
      });
      await new Promise((r) => setTimeout(r, 500)); // let anvil mine

      now += 5_000; // still inside the 15s window
      const stillCached = await reader.anchorCount();
      ok(!isUnreachable(stillCached), "cache test: still-cached read reachable");
      if (!isUnreachable(stillCached)) {
        ok(stillCached.count === first.count, "within 15s the cached value is returned, not the new on-chain count", String(stillCached.count));
        ok(stillCached.stale_at === first.stale_at, "stale_at is unchanged on a cache hit");
      }

      now += 11_000; // now 16s after the first fetch — past the 15s TTL
      const refetched = await reader.anchorCount();
      ok(!isUnreachable(refetched), "cache test: post-expiry read reachable");
      if (!isUnreachable(refetched)) {
        ok(refetched.count === 2, "past the 15s TTL the reader refetches and sees the second anchor", String(refetched.count));
        ok(refetched.stale_at === now + 15_000, "a fresh fetch gets a fresh stale_at");
      }
    }

    // --------------------------------------------------------------------- unreachable
    {
      const deadTarget = { ...targets[0]!, id: targets[0]!.id, rpc: "http://127.0.0.1:1" };
      const reader = new ViemChainReader([deadTarget]);
      const r = await reader.anchorCount();
      ok(isUnreachable(r), "a dead RPC port reports unreachable, not a fabricated count");
      if (isUnreachable(r)) ok(r.chain_id === deadTarget.id, "unreachable result names the chain");

      const corpus = await reader.corpusAt(0);
      ok(isUnreachable(corpus), "LicenceRegistry reads report unreachable too when the primary is down");
    }
  } finally {
    anvil?.kill("SIGKILL");
    rmSync(envDir, { recursive: true, force: true });
  }
}

await main();

if (fails > 0) {
  console.log(`\n${fails} chain test(s) FAILED`);
  process.exit(1);
} else {
  console.log("\nall chain tests passed");
}
