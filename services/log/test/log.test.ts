/** The log store: persistence, coherence, and the proofs it must serve. */
import { keccak256, toHex, type Account, type Hex } from "viem";
import { rmSync, existsSync } from "node:fs";
import { LogStore } from "../src/store.ts";
import * as ct from "../../../packages/protocol/src/log.ts";
import { SparseTree, computeRoot, ZERO } from "../../../packages/protocol/src/sparse.ts";
import { loadChains, type ChainTarget } from "../src/chains.ts";
import {
  anchorHead, anchorAll, checkDivergence, type Clients, type Reader, type Writer,
} from "../src/anchorer.ts";
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

const PATH = "/tmp/thenar-log-test.db";
for (const f of [PATH, `${PATH}-wal`, `${PATH}-shm`]) if (existsSync(f)) rmSync(f);

let store = new LogStore(PATH);
ok(store.size() === 0, "a fresh log is empty");
ok(store.root() === keccak256("0x"), "an empty log has the empty-tree root");

// --- append ---------------------------------------------------------------
const leaves: Hex[] = [];
for (let i = 0; i < 9; i++) {
  const leaf = h(`leaf-${i}`);
  leaves.push(leaf);
  ok(store.append(leaf, { taskId: h("task-a"), qualityScore: 6000 + i * 100, success: i % 4 === 3 ? 0 : 1 }) === i,
     `append returns index ${i}`);
}
ok(store.size() === 9, "the log holds every appended leaf");
ok(store.root() === ct.root(leaves), "the store's root matches the reference implementation");

// A duplicate must be refused rather than silently reindexed.
let dupRefused = false;
try { store.append(leaves[3]); } catch { dupRefused = true; }
ok(dupRefused, "appending the same leaf twice is refused");

// --- coherence: this is the bug the store exists to make inexpressible ------
const size = store.size();
const root = store.root();
ok(ct.root(store.leaves(size)) === root, "root and size always describe the same tree", `size ${size}`);

// --- proofs ---------------------------------------------------------------
function replayInclusion(leaf: Hex, proof: Hex[], index: number, n: number): Hex {
  let node = leaf, i = index, m = n, p = 0;
  while (m > 1) {
    if (i % 2 === 1) node = ct.hashNode(proof[p++], node);
    else if (i + 1 < m) node = ct.hashNode(node, proof[p++]);
    i = Math.floor(i / 2); m = Math.ceil(m / 2);
  }
  return node;
}
let allIn = true;
for (let i = 0; i < size; i++) {
  if (replayInclusion(leaves[i], store.inclusionProof(i), i, size) !== root) allIn = false;
}
ok(allIn, "every stored leaf proves inclusion against the stored root", `${size}/${size}`);

ok(store.indexOfLeaf(leaves[5]) === 5, "a leaf is findable by its hash");
ok(store.indexOfLeaf(h("never-appended")) === null, "an unknown leaf reports null, not zero");

// Consistency across a prefix.
const m = 5;
const proofC = store.consistencyProof(m);
ok(proofC.length > 0 && store.root(m) === ct.root(leaves.slice(0, m)),
   "a prefix root matches and a consistency proof is produced", `${proofC.length} words`);

// --- metadata a corpus is built from --------------------------------------
const forTask = store.byTask(h("task-a"));
ok(forTask.length === 9, "episodes are retrievable by task");
ok(forTask.filter((l) => l.success === 1).length === 7, "success flags persist", "7 of 9");
ok(forTask[2].qualityScore === 6200, "quality scores persist");

// --- revocations ----------------------------------------------------------

// A bad signature must throw and write nothing.
{
  const bad = await signedRevocation("bad");
  const forged = ("0x" + "ab".repeat(64)) as Hex;
  let threw = false;
  try { await store.revoke(bad.record, forged); } catch { threw = true; }
  ok(threw, "revoke with an invalid signature throws");
  ok(store.revocations().every((r) => r.consentKey !== bad.consentKey),
     "the rejected revocation wrote nothing to the store");
}

const rev1 = await signedRevocation("1");
const inserted = await store.revoke(rev1.record, rev1.signature);
ok(inserted.consentKey === rev1.consentKey && inserted.value === rev1.value,
   "a validly-signed revocation round-trips the derived (consentKey, value)");

// Repeating the same signed revocation is idempotent, not an error.
const insertedAgain = await store.revoke(rev1.record, rev1.signature);
ok(insertedAgain.consentKey === rev1.consentKey && insertedAgain.value === rev1.value,
   "revoking the same record twice is idempotent");
ok(store.revocations().filter((r) => r.consentKey === rev1.consentKey).length === 1,
   "a repeated revocation does not duplicate the row");

const tree = new SparseTree();
for (const r of store.revocations()) tree.set(r.consentKey, r.value);
const revRoot = tree.root();
ok(revRoot !== ZERO, "a revocation moves the sparse root");
const live = tree.proof(h("consent-never-revoked"));
ok(computeRoot(h("consent-never-revoked"), ZERO, live.bitmap, live.siblings) === revRoot,
   "an unrevoked key still proves non-membership");

// --- anchors and persistence ----------------------------------------------
store.recordAnchor(0, root, size, revRoot, "0xabc", 123);
ok(store.lastAnchoredSize() === 9, "the anchored size is recorded");

store.close();
store = new LogStore(PATH);
ok(store.size() === 9, "leaves survive a restart");
ok(store.root() === root, "the root is identical after reopening", "persistence is real");
ok(store.anchors().length === 1 && store.anchors()[0].size === 9, "anchors survive a restart");
ok(store.byTask(h("task-a")).length === 9, "task metadata survives a restart");

// Appending after a restart continues the same tree.
store.append(h("leaf-9"), { taskId: h("task-a") });
ok(store.size() === 10, "the log continues after a restart");
ok(store.root() === ct.root([...leaves, h("leaf-9")]), "the extended root matches the reference");
const proofAfter = store.consistencyProof(9, 10);
ok(proofAfter.length > 0, "a consistency proof spans the restart", `${proofAfter.length} words`);

store.close();

// ============================================================================
// chains.ts — loadChains() against a fixture .env.contracts
// ============================================================================

const FIXTURE_ENV = new URL("./fixtures/env.contracts", import.meta.url).pathname;
const chains = loadChains(FIXTURE_ENV);
ok(chains.length === 2, "loadChains reads both fixture chains");
ok(chains[0].role === "primary" && chains[0].id === 43113, "the primary chain sorts first");
ok(chains[1].role === "mirror" && chains[1].id === 11155111, "the mirror chain sorts after the primary");
ok(chains[0].name === "Avalanche Fuji", "a known chain id gets its name");
ok(chains[0].log === "0x1111111111111111111111111111111111111111", "the log address is parsed");

// ============================================================================
// anchorer.ts — anchorHead / anchorAll / checkDivergence against a fake
// in-memory GraspLog implementing the D-17 rule, so no Anvil is required.
// ============================================================================

const SIGNER = { address: "0x000000000000000000000000000000000000dEaD" } as unknown as Account;

/** An in-memory model of `GraspLog.anchor`'s D-17 rule. */
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

const DIV_PATH = "/tmp/thenar-log-test-divergence.db";
for (const f of [DIV_PATH, `${DIV_PATH}-wal`, `${DIV_PATH}-shm`]) if (existsSync(f)) rmSync(f);

{
  // --- equal heads on two chains ------------------------------------------
  const s = new LogStore(":memory:");
  s.append(h("a"));
  s.append(h("b"));

  const primary = fakeTarget(1, "primary");
  const mirror = fakeTarget(2, "mirror");
  const primaryChain = new FakeGraspLog();
  const mirrorChain = new FakeGraspLog();
  const clientsFor = (t: ChainTarget): Clients => {
    const chain = t.id === 1 ? primaryChain : mirrorChain;
    return { pub: chain, wallet: chain };
  };

  const outcomes = await anchorAll(s, SIGNER, [primary, mirror], clientsFor);
  ok(outcomes.length === 2, "anchorAll returns one outcome per chain");
  ok(outcomes.every((o) => o.anchored), "both chains anchor the current head");
  ok(primaryChain.anchors[0].root === mirrorChain.anchors[0].root, "primary and mirror anchor the same root");
  ok(primaryChain.anchors[0].size === mirrorChain.anchors[0].size, "primary and mirror anchor the same size");
  ok(s.anchorsForChain(1).length === 1 && s.anchorsForChain(2).length === 1,
     "the store records one anchor_chain row per chain");
  ok(s.anchors().length === 1, "the legacy anchor table gets one row, from the primary only");

  // Anchoring again with nothing new appended anchors nothing.
  const again = await anchorAll(s, SIGNER, [primary, mirror], clientsFor);
  ok(again.every((o) => !o.anchored && !o.error), "a second anchorAll with no new leaves anchors nothing on either chain");

  // --- mirror lag catch-up -------------------------------------------------
  s.append(h("c"));
  s.append(h("d"));
  s.append(h("e"));
  // Only the primary anchors this head; the mirror is left behind.
  const primaryOnly = await anchorHead(s, primary, SIGNER, clientsFor(primary));
  ok(primaryOnly !== null && primaryChain.anchors.length === 2, "the primary anchors while the mirror lags");
  ok(mirrorChain.anchors.length === 1, "the mirror has not caught up yet");

  const catchUp = await anchorAll(s, SIGNER, [primary, mirror], clientsFor);
  ok(catchUp[1].anchored, "the mirror catches up on the next anchorAll");
  ok(mirrorChain.anchors.length === 2, "the mirror anchors only the latest head, not each skipped one");
  ok(mirrorChain.anchors[mirrorChain.anchors.length - 1].size === BigInt(s.size()),
     "the mirror's catch-up anchor carries the current size, skipping the intermediate ones");

  // --- revocation-only anchor -----------------------------------------------
  const revX = await signedRevocation("x");
  await s.revoke(revX.record, revX.signature);
  const beforeSize = s.size();
  const revOnly = await anchorHead(s, primary, SIGNER, clientsFor(primary));
  ok(revOnly !== null, "a revocation with no new leaves still produces an anchor");
  ok(revOnly!.size === beforeSize, "a revocation-only anchor keeps the same size");
  const last = primaryChain.anchors[primaryChain.anchors.length - 1];
  const prev = primaryChain.anchors[primaryChain.anchors.length - 2];
  ok(last.size === prev.size && last.revocationRoot !== prev.revocationRoot,
     "the chain records same size, changed revocation root — exactly the D-17 revocation-only case");
  ok(last.root === prev.root, "the log root itself is unchanged by a revocation-only anchor");

  // A second anchor attempt with the same size and revocation root is "nothing new" —
  // the anchorer must treat this the way it would treat a NothingToAnchor revert.
  const nothingAfterRev = await anchorHead(s, primary, SIGNER, clientsFor(primary));
  ok(nothingAfterRev === null, "anchoring again with the same size and revocation root anchors nothing");

  // --- store-behind-chain error ---------------------------------------------
  const s2 = new LogStore(":memory:");
  s2.append(h("only-one"));
  const behindTarget = fakeTarget(3, "primary");
  const aheadChain = new FakeGraspLog();
  await aheadChain.writeContract({ functionName: "anchor", args: [h("some-root"), 5n, ZERO] });
  let threw = false;
  try {
    await anchorHead(s2, behindTarget, SIGNER, { pub: aheadChain, wallet: aheadChain });
  } catch (e) {
    threw = (e as Error).message.includes("behind");
  }
  ok(threw, "anchoring when the store holds fewer leaves than the chain has anchored throws, not silently anchors");
  s2.close();

  // --- divergence detection ---------------------------------------------------
  const divPrimary = fakeTarget(10, "primary");
  const divMirror = fakeTarget(11, "mirror");
  const divPrimaryChain = new FakeGraspLog();
  const divMirrorChain = new FakeGraspLog();
  const rootA = h("root-A");
  const rootB = h("root-B");
  await divPrimaryChain.writeContract({ functionName: "anchor", args: [rootA, 4n, ZERO] });
  // The mirror anchors a *different* root at the same size — a forked/compromised mirror.
  await divMirrorChain.writeContract({ functionName: "anchor", args: [rootB, 4n, ZERO] });

  const divergences = await checkDivergence(s, [divPrimary, divMirror], (t) =>
    t.id === 10 ? divPrimaryChain : divMirrorChain);
  ok(divergences.length === 1 && divergences[0].chainId === 11,
     "checkDivergence flags the mirror whose root differs from the primary's at the same size");

  await divPrimaryChain.writeContract({ functionName: "anchor", args: [h("root-A2"), 8n, ZERO] });
  const noDivergence = await checkDivergence(s, [divPrimary, divMirror], (t) =>
    t.id === 10 ? divPrimaryChain : divMirrorChain);
  ok(noDivergence.length === 1, "a size the mirror never reached is not compared, so no new divergence appears");

  s.close();
}

console.log(fails === 0 ? "\nlog store: all checks passed\n" : `\n${fails} check(s) failed\n`);
process.exit(fails ? 1 : 0);
