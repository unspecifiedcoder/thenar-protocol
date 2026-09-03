/** Daemon scheduling, backoff, lag alarm, and mirror synchronization. */

import { keccak256, toHex, type Account, type Hex } from "viem";
import { rmSync, existsSync } from "node:fs";
import { LogStore } from "../src/store.ts";
import * as ct from "../../../packages/protocol/src/log.ts";
import { ZERO } from "../../../packages/protocol/src/sparse.ts";
import { tick, getState, getMetrics } from "../src/daemon.ts";
import { type ChainTarget } from "../src/chains.ts";
import { type Clients, type Reader, type Writer } from "../src/anchorer.ts";
import {
  newConsentRecord, recordHash, consentKey as deriveConsentKey, revocationValue, type ConsentRecord,
} from "../../../packages/protocol/src/consent.ts";
import { sign } from "../../../packages/protocol/src/sign.ts";
import * as ed from "@noble/ed25519";

let fails = 0;
const ok = (c: boolean, m: string, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };
const h = (s: string): Hex => keccak256(toHex(s));

/** Builds a fresh, validly-signed (ed25519) revocation for one episode's consent. */
async function signedRevocation(seed: string): Promise<{
  record: ConsentRecord; signature: Hex; consentKey: Hex; value: Hex;
}> {
  const sk = ed.utils.randomSecretKey();
  const pubkey = await ed.getPublicKeyAsync(sk);
  const record = newConsentRecord({
    holder: "contributor",
    pubkey: toHex(pubkey),
    alg: "ed25519",
    scope_bits: 0b1,
    terms_hash: h(`terms-${seed}`),
    granted_at: 1756900000,
  });
  const hash = recordHash(record);
  const consentKey = deriveConsentKey(hash);
  const value = revocationValue(hash);
  const signature = await sign("ed25519", "revoke", consentKey, toHex(sk));
  return { record, signature, consentKey, value };
}

const SIGNER = { address: "0x000000000000000000000000000000000000dEaD" } as unknown as Account;

/** In-memory model of GraspLog implementing D-17. */
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

const store = new LogStore(PATH);
const leaves: Hex[] = [];
for (let i = 0; i < 3; i++) {
  const leaf = h(`leaf-${i}`);
  leaves.push(leaf);
  store.append(leaf);
}

ok(store.size() === 3, "store has 3 leaves");

const primary = fakeTarget(1, "primary");
const mirror = fakeTarget(2, "mirror");
const primaryChain = new FakeGraspLog();
const mirrorChain = new FakeGraspLog();

const clientsFor = (t: ChainTarget): Clients => {
  const chain = t.id === 1 ? primaryChain : mirrorChain;
  return { pub: chain, wallet: chain };
};

// ============================================================================
// Test 1: Primary anchors at interval
// ============================================================================

{
  getState().clear();

  const interval = 3600;
  const keyTimes = [0, interval, interval * 2, interval * 3];
  const anchorsByPrimary: number[] = [];

  for (const t of keyTimes) {
    let state = getState();
    let primaryState = state.get(primary.id);
    if (!primaryState) {
      primaryState = { lastSuccessAt: 0, lastAttemptAt: 0, failureCount: 0 };
      state.set(primary.id, primaryState);
    }

    const ticked = await tick(store, primary, SIGNER, t, primaryState, {
      store,
      signer: SIGNER,
      chains: [primary, mirror],
      clientsFor,
      anchorIntervalSecondsPrimary: interval,
      anchorIntervalSecondsMirror: 86400,
      now: () => t,
    });

    if (ticked) {
      anchorsByPrimary.push(t);
    }
  }

  ok(anchorsByPrimary.length === 1, `primary anchored once in 3 hours (got ${anchorsByPrimary.length})`, `at t=${anchorsByPrimary[0]}`);
  ok(primaryChain.anchors.length === 1, "primary chain recorded 1 anchor");
}

// ============================================================================
// Test 2: Revocation-only anchor (same size, different revocationRoot)
// ============================================================================

{
  const s = new LogStore(":memory:");
  s.append(h("a"));
  s.append(h("b"));
  getState().clear();

  const prim = fakeTarget(10, "primary");
  const primChain = new FakeGraspLog();
  const clientsFor2 = (t: ChainTarget): Clients => {
    const chain = t.id === 10 ? primChain : new FakeGraspLog();
    return { pub: chain, wallet: chain };
  };

  let simTime = 0;

  // First anchor: size 2.
  const state1 = { lastSuccessAt: 0, lastAttemptAt: 0, failureCount: 0 };
  await tick(s, prim, SIGNER, simTime, state1, {
    store: s,
    signer: SIGNER,
    chains: [prim],
    clientsFor: clientsFor2,
    anchorIntervalSecondsPrimary: 3600,
    now: () => simTime,
  });
  state1.lastSuccessAt = simTime;

  ok(primChain.anchors.length === 1, "first anchor recorded");
  ok(primChain.anchors[0].size === 2n, "size is 2");
  ok(primChain.anchors[0].revocationRoot === ZERO, "initial revocationRoot is ZERO");

  // Add a revocation (no new leaves).
  const rev = await signedRevocation("x");
  await s.revoke(rev.record, rev.signature);

  simTime += 1;

  // Second anchor: same size, different revocationRoot.
  state1.lastSuccessAt = 0; // Reset to allow immediate re-anchor.
  state1.lastAttemptAt = 0;
  const ticked = await tick(s, prim, SIGNER, simTime, state1, {
    store: s,
    signer: SIGNER,
    chains: [prim],
    clientsFor: clientsFor2,
    anchorIntervalSecondsPrimary: 3600,
    now: () => simTime,
  });

  ok(ticked, "revocation-only change triggers an anchor");
  ok(primChain.anchors.length === 2, "second anchor recorded");
  ok(primChain.anchors[1].size === 2n, "revocation-only anchor keeps same size");
  ok(primChain.anchors[1].revocationRoot !== ZERO, "revocationRoot changed");
  ok(primChain.anchors[1].root === primChain.anchors[0].root, "log root unchanged");

  s.close();
}

// ============================================================================
// Test 3: Backoff timing after failure
// ============================================================================

{
  const s = new LogStore(":memory:");
  s.append(h("x"));
  getState().clear();

  const prim = fakeTarget(20, "primary");
  let attemptCount = 0;
  const failingChain = {
    async readContract() { return 0n; },
    async writeContract() {
      attemptCount += 1;
      throw new Error("synthetic anchor failure");
    },
    async waitForTransactionReceipt() { return { status: "success", blockNumber: 1n }; },
  } as any;

  const clientsFor3 = (t: ChainTarget): Clients => {
    return { pub: failingChain, wallet: failingChain };
  };

  const originalError = console.error;
  console.error = () => { }; // Suppress error logs for this test.

  const chainState = { lastSuccessAt: 0, lastAttemptAt: 0, failureCount: 0 };

  // Attempt 1: fails at t=0.
  await tick(s, prim, SIGNER, 0, chainState, {
    store: s,
    signer: SIGNER,
    chains: [prim],
    clientsFor: clientsFor3,
    anchorIntervalSecondsPrimary: 3600,
    now: () => 0,
  });
  ok(chainState.failureCount === 1, "first failure increments to 1");
  ok(attemptCount === 1, "first attempt was made");

  // Attempt 2 at t=10 (< 30 s backoff): should not retry.
  const tickedEarly = await tick(s, prim, SIGNER, 10, chainState, {
    store: s,
    signer: SIGNER,
    chains: [prim],
    clientsFor: clientsFor3,
    anchorIntervalSecondsPrimary: 3600,
    now: () => 10,
  });
  ok(!tickedEarly, "backoff prevents retry within 30 s");
  ok(attemptCount === 1, "no additional attempt");

  // Attempt 3 at t=30 (>= 30 s backoff): should retry.
  await tick(s, prim, SIGNER, 30, chainState, {
    store: s,
    signer: SIGNER,
    chains: [prim],
    clientsFor: clientsFor3,
    anchorIntervalSecondsPrimary: 3600,
    now: () => 30,
  });
  ok(attemptCount === 2, "second attempt made after backoff");
  ok(chainState.failureCount === 2, "second failure increments to 2");

  console.error = originalError;
  s.close();
}

// ============================================================================
// Test 4: Mirror does not anchor ahead of primary
// ============================================================================

{
  const s = new LogStore(":memory:");
  s.append(h("mirror-test-1"));
  s.append(h("mirror-test-2"));
  s.append(h("mirror-test-3"));
  getState().clear();

  const prim = fakeTarget(40, "primary");
  const mir = fakeTarget(41, "mirror");
  const primChain = new FakeGraspLog();
  const mirChain = new FakeGraspLog();

  const clientsFor5 = (t: ChainTarget): Clients => {
    const chain = t.id === 40 ? primChain : mirChain;
    return { pub: chain, wallet: chain };
  };

  // Primary anchors at t=0.
  const primState = { lastSuccessAt: 0, lastAttemptAt: 0, failureCount: 0 };
  await tick(s, prim, SIGNER, 0, primState, {
    store: s,
    signer: SIGNER,
    chains: [prim, mir],
    clientsFor: clientsFor5,
    anchorIntervalSecondsPrimary: 3600,
    anchorIntervalSecondsMirror: 86400,
    now: () => 0,
  });
  primState.lastSuccessAt = 0;

  ok(primChain.anchors.length === 1, "primary anchored");

  // Mirror tries at t=1: interval not reached, so shouldn't tick.
  const mirState = { lastSuccessAt: 0, lastAttemptAt: 0, failureCount: 0 };
  const mirrorTicked = await tick(s, mir, SIGNER, 1, mirState, {
    store: s,
    signer: SIGNER,
    chains: [prim, mir],
    clientsFor: clientsFor5,
    anchorIntervalSecondsPrimary: 3600,
    anchorIntervalSecondsMirror: 86400,
    now: () => 1,
  });

  ok(!mirrorTicked, "mirror does not tick before its interval");
  ok(mirChain.anchors.length === 0, "mirror did not anchor yet");

  s.close();
}

store.close();

console.log(fails === 0 ? "\ndaemon: all checks passed\n" : `\n${fails} check(s) failed\n`);
process.exit(fails ? 1 : 0);
