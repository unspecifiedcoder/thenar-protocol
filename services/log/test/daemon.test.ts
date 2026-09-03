/** Daemon scheduling and basic functionality. */

import { keccak256, toHex, type Account, type Hex } from "viem";
import { rmSync, existsSync } from "node:fs";
import { LogStore } from "../src/store.ts";
import { tick, getState } from "../src/daemon.ts";
import { type ChainTarget } from "../src/chains.ts";
import { type Clients, type Reader, type Writer } from "../src/anchorer.ts";
import { ZERO } from "../../../packages/protocol/src/sparse.ts";

let fails = 0;
const ok = (c: boolean, m: string, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };
const h = (s: string): Hex => keccak256(toHex(s));

const SIGNER = { address: "0x000000000000000000000000000000000000dEaD" } as unknown as Account;

/** In-memory fake GraspLog. */
class FakeGraspLog implements Reader, Writer {
  anchors: { root: Hex; revocationRoot: Hex; size: bigint; blockNumber: bigint }[] = [];
  private block = 0n;
  private txs = 0;

  async readContract(args: { functionName: string; args?: readonly unknown[] }): Promise<unknown> {
    if (args.functionName === "anchorCount") return BigInt(this.anchors.length);
    if (args.functionName === "anchorAt") {
      const i = Number((args.args as readonly unknown[])[0]);
      const a = this.anchors[i];
      if (!a) throw new Error("UnknownAnchor");
      return a;
    }
    throw new Error(`FakeGraspLog: unexpected read ${args.functionName}`);
  }

  async writeContract(args: { functionName: string; args?: readonly unknown[] }): Promise<Hex> {
    if (args.functionName !== "anchor") throw new Error(`FakeGraspLog: unexpected write ${args.functionName}`);
    const [root, size, revocationRoot] = args.args as [Hex, bigint, Hex];
    const head = this.anchors[this.anchors.length - 1];
    if (!head) {
      if (size === 0n) throw new Error("SizeMustGrow(0,0)");
    } else {
      if (size < head.size) throw new Error(`SizeMustNotShrink(${head.size},${size})`);
      if (size > head.size && root === head.root) throw new Error("RootMustChange()");
      if (size === head.size && root !== head.root) throw new Error("RootMustMatchAtSameSize()");
      if (size === head.size && revocationRoot === head.revocationRoot) throw new Error("NothingToAnchor()");
    }
    this.block += 1n;
    this.txs += 1;
    this.anchors.push({ root, revocationRoot, size, blockNumber: this.block });
    return `0xtx-${this.txs}` as Hex;
  }

  async waitForTransactionReceipt(_args: { hash: Hex }): Promise<{ status: string; blockNumber: bigint }> {
    return { status: "success", blockNumber: this.block };
  }
}

function fakeTarget(id: number, role: "primary" | "mirror"): ChainTarget {
  return { id, name: `fake-${id}`, rpc: "http://fake", log: "0xfake" as Hex, confirmations: 1, role };
}

const PATH = "/tmp/thenar-daemon-test.db";
for (const f of [PATH, `${PATH}-wal`, `${PATH}-shm`]) if (existsSync(f)) rmSync(f);

async function main() {
  // ============================================================================
  // Test 1: Primary anchors at interval
  // ============================================================================

  {
    getState().clear();

    const store = new LogStore(PATH);
    store.append(h("leaf-0"));
    store.append(h("leaf-1"));
    store.append(h("leaf-2"));

    const primary = fakeTarget(1, "primary");
    const primaryChain = new FakeGraspLog();
    const clientsFor = (t: ChainTarget): Clients => {
      return { pub: primaryChain, wallet: primaryChain };
    };

    const interval = 3600;

    // First tick at t=0.
    let state = getState();
    let primaryState = state.get(primary.id);
    if (!primaryState) {
      primaryState = { lastSuccessAt: 0, lastAttemptAt: 0, failureCount: 0 };
      state.set(primary.id, primaryState);
    }

    await tick(store, primary, SIGNER, 0, primaryState, {
      store,
      signer: SIGNER,
      chains: [primary],
      clientsFor,
      anchorIntervalSecondsPrimary: interval,
      now: () => 0,
    });

    ok(primaryChain.anchors.length === 1, "primary anchored at t=0");
    ok(primaryChain.anchors[0].size === 3n, "size is 3");

    // Second tick at t=3600 (interval).
    state = getState();
    primaryState = state.get(primary.id)!;

    await tick(store, primary, SIGNER, interval, primaryState, {
      store,
      signer: SIGNER,
      chains: [primary],
      clientsFor,
      anchorIntervalSecondsPrimary: interval,
      now: () => interval,
    });

    ok(primaryChain.anchors.length === 1, "no second anchor at t=3600 (nothing new to anchor)");

    store.close();
  }

  // ============================================================================
  // Test 2: Backoff on failure
  // ============================================================================

  {
    getState().clear();

    const store = new LogStore(":memory:");
    store.append(h("leaf-0"));

    const primary = fakeTarget(2, "primary");
    let attemptCount = 0;

    const failingChain = {
      async readContract() {
        return 0n;
      },
      async writeContract() {
        attemptCount += 1;
        throw new Error("synthetic failure");
      },
      async waitForTransactionReceipt() {
        return { status: "success", blockNumber: 1n };
      },
    } as any;

    const clientsFor = () => ({ pub: failingChain, wallet: failingChain });

    const originalError = console.error;
    console.error = () => { }; // Suppress logs for this test.

    const chainState = { lastSuccessAt: 0, lastAttemptAt: 0, failureCount: 0 };

    // Attempt 1 at t=0: should fail.
    await tick(store, primary, SIGNER, 0, chainState, {
      store,
      signer: SIGNER,
      chains: [primary],
      clientsFor,
      anchorIntervalSecondsPrimary: 3600,
      now: () => 0,
    });

    ok(attemptCount === 1, "first attempt made");
    ok(chainState.failureCount === 1, "failure count is 1");

    // Attempt 2 at t=10: backoff should prevent retry.
    await tick(store, primary, SIGNER, 10, chainState, {
      store,
      signer: SIGNER,
      chains: [primary],
      clientsFor,
      anchorIntervalSecondsPrimary: 3600,
      now: () => 10,
    });

    ok(attemptCount === 1, "no attempt at t=10 (backoff prevents it)");

    // Attempt 3 at t=30: backoff should allow retry.
    await tick(store, primary, SIGNER, 30, chainState, {
      store,
      signer: SIGNER,
      chains: [primary],
      clientsFor,
      anchorIntervalSecondsPrimary: 3600,
      now: () => 30,
    });

    ok(attemptCount === 2, "second attempt made at t=30");
    ok(chainState.failureCount === 2, "failure count is 2");

    console.error = originalError;
    store.close();
  }

  console.log(fails === 0 ? "\ndaemon: all checks passed\n" : `\n${fails} check(s) failed\n`);
  process.exit(fails ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
