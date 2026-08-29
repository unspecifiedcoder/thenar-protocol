/** The log store: persistence, coherence, and the proofs it must serve. */
import { keccak256, toHex, type Hex } from "viem";
import { rmSync, existsSync } from "node:fs";
import { LogStore } from "../src/store.ts";
import * as ct from "../../../packages/protocol/src/log.ts";
import { SparseTree, computeRoot, ZERO } from "../../../packages/protocol/src/sparse.ts";

let fails = 0;
const ok = (c: boolean, m: string, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };
const h = (s: string): Hex => keccak256(toHex(s));

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
store.revoke(h("consent-1"), h("record-1"));
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
console.log(fails === 0 ? "\nlog store: all checks passed\n" : `\n${fails} check(s) failed\n`);
process.exit(fails ? 1 : 0);
