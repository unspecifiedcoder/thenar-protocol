/** Self-checks for the off-chain protocol library. */
import { keccak256, toHex, type Hex } from "viem";
import { encodeClip, clipLeaf, PREIMAGE_BYTES, commitConsent } from "../src/leaf";
import * as log from "../src/log";
import { SparseTree, computeRoot, ZERO } from "../src/sparse";

let fails = 0;
const ok = (cond: boolean, msg: string, extra = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${msg}${extra ? ` — ${extra}` : ""}`);
};

const h = (s: string): Hex => keccak256(toHex(s));

// ---------------------------------------------------------------- leaf
const clip = {
  payloadHash: h("payload"),
  manifestHash: h("manifest"),
  consentCommitment: commitConsent(h("consent"), h("salt")),
  termsId: h("terms-v1"),
  capturedAt: 1787000000n,
  submittedAt: 1787000060n,
  durationMs: 4200,
  scopeBits: 0b1011,
  channels: 6,
};
const pre = encodeClip(clip);
ok((pre.length - 2) / 2 === PREIMAGE_BYTES, "clip preimage is exactly 154 bytes", `${(pre.length - 2) / 2}`);
ok(clipLeaf(clip).length === 66, "leaf hash is 32 bytes");

// A fresh salt must unlink two clips from the same consent record.
const c1 = commitConsent(h("consent"), h("salt-a"));
const c2 = commitConsent(h("consent"), h("salt-b"));
ok(c1 !== c2, "re-salting unlinks two commitments of the same consent");

// ---------------------------------------------------------------- log
const leaves: Hex[] = Array.from({ length: 11 }, (_, i) => h(`clip-${i}`));
const r11 = log.root(leaves);
ok(r11.length === 66, "log root computes for a non-power-of-two tree", "n=11");

// Inclusion, verified by replaying the walk the contract does.
function replayInclusion(leaf: Hex, proof: Hex[], index: number, size: number): Hex {
  let node = leaf, i = index, n = size, p = 0;
  while (n > 1) {
    if (i % 2 === 1) node = log.hashNode(proof[p++], node);
    else if (i + 1 < n) node = log.hashNode(node, proof[p++]);
    i = Math.floor(i / 2);
    n = Math.ceil(n / 2);
  }
  if (p !== proof.length) throw new Error("proof length mismatch");
  return node;
}
let allIn = true;
for (let i = 0; i < leaves.length; i++) {
  const proof = log.inclusionProof(leaves, i);
  if (replayInclusion(leaves[i], proof, i, leaves.length) !== r11) allIn = false;
}
ok(allIn, "every leaf proves inclusion against the root", "11/11");

// A tampered leaf must not verify.
const badProof = log.inclusionProof(leaves, 3);
ok(replayInclusion(h("not-the-clip"), badProof, 3, leaves.length) !== r11,
   "a substituted leaf fails inclusion");

// Consistency: every prefix of the log must prove append-only.
let allConsistent = true;
for (let m = 1; m < leaves.length; m++) {
  const proof = log.consistencyProof(leaves, m, leaves.length);
  const rm = log.root(leaves.slice(0, m));
  if (!replayConsistency(m, rm, leaves.length, r11, proof)) allConsistent = false;
}
ok(allConsistent, "every prefix proves the log is append-only", "10/10");

// D-17's equal-size anchor needs a same-size consistency proof to be trivial,
// since a revocation-only anchor keeps m === n.
ok(log.consistencyProof(leaves, leaves.length, leaves.length).length === 0,
   "consistencyProof(m, n) with m === n returns an empty proof");

function replayConsistency(m: number, first: Hex, n: number, second: Hex, proof: Hex[]): boolean {
  if (m === n) return proof.length === 0 && first === second;
  let node = m - 1, last = n - 1, p = 0;
  while (node % 2 === 1) { node = Math.floor(node / 2); last = Math.floor(last / 2); }
  let fr: Hex, sr: Hex;
  if (node > 0) { fr = proof[p]; sr = proof[p]; p++; } else { fr = first; sr = first; }
  while (node > 0) {
    if (node % 2 === 1) { const s = proof[p++]; fr = log.hashNode(s, fr); sr = log.hashNode(s, sr); }
    else if (node < last) { sr = log.hashNode(sr, proof[p++]); }
    node = Math.floor(node / 2); last = Math.floor(last / 2);
  }
  while (last > 0) { sr = log.hashNode(sr, proof[p++]); last = Math.floor(last / 2); }
  return p === proof.length && fr === first && sr === second;
}

// ---------------------------------------------------------------- sparse
const t = new SparseTree();
ok(t.root() === ZERO, "an empty revocation tree is the zero word");

const revoked = h("consent-key-revoked");
const live = h("consent-key-live");
t.set(revoked, h("revocation-record"));
const sroot = t.root();
ok(sroot !== ZERO, "writing a revocation moves the root");

const pIn = t.proof(revoked);
ok(computeRoot(revoked, h("revocation-record"), pIn.bitmap, pIn.siblings) === sroot,
   "a revoked key proves membership");

const pOut = t.proof(live);
ok(computeRoot(live, ZERO, pOut.bitmap, pOut.siblings) === sroot,
   "a key never written proves NON-membership", `${pOut.siblings.length} siblings`);

// The proof must actually be compact, not 256 words.
ok(pOut.siblings.length < 8, "non-membership proof is compact", `${pOut.siblings.length} words`);

// Non-membership must fail once the key is revoked.
t.set(live, h("second-revocation"));
const sroot2 = t.root();
const pStale = t.proof(live);
ok(computeRoot(live, ZERO, pStale.bitmap, pStale.siblings) !== sroot2,
   "a revoked key can no longer prove it is live");

console.log(fails === 0 ? "\nprotocol library: all checks passed\n" : `\n${fails} check(s) failed\n`);
process.exit(fails ? 1 : 0);
