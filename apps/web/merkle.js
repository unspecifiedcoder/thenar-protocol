/* merkle.js — CT log (RFC 6962) and sparse-Merkle verification, ported for
 * the browser with no bundler.
 *
 * Port of `packages/protocol/src/log.ts` (§10.1) and the verification half
 * of `packages/protocol/src/sparse.ts` (§10.2, `computeRoot` only — the
 * page never needs to build a tree, only fold a proof). `verify.test.mjs`
 * checks this module against the `ct` and `sparse` fixtures in
 * `packages/protocol/test/fixtures/vectors.json`, and against
 * `packages/protocol/src/log.ts` directly for sizes 1..64.
 */
import { keccak256 } from "./keccak.js";

const ZERO32 = "0x" + "00".repeat(32);

/* ------------------------------------------------------------------ *
 * §10.1 — CT log
 * ------------------------------------------------------------------ */

export const hashNode = (l, r) => keccak256(("0x01" + l.slice(2) + r.slice(2)));

/** Largest power of two strictly less than n. */
function split(n) {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

/** RFC 6962 root over `leaves` (already leaf-hashed, §10.1). */
export function root(leaves) {
  if (leaves.length === 0) return keccak256("0x");
  if (leaves.length === 1) return leaves[0];
  const k = split(leaves.length);
  return hashNode(root(leaves.slice(0, k)), root(leaves.slice(k)));
}

/** Path from `index` up to the root, siblings only, leaf-to-root order. */
export function inclusionProof(leaves, index) {
  if (index < 0 || index >= leaves.length) throw new Error("index out of range");
  if (leaves.length === 1) return [];
  const k = split(leaves.length);
  return index < k
    ? [...inclusionProof(leaves.slice(0, k), index), root(leaves.slice(k))]
    : [...inclusionProof(leaves.slice(k), index - k), root(leaves.slice(0, k))];
}

function sub(leaves, m, isComplete) {
  const n = leaves.length;
  if (m === n) return isComplete ? [] : [root(leaves)];
  const k = split(n);
  if (m <= k) return [...sub(leaves.slice(0, k), m, isComplete), root(leaves.slice(k))];
  return [...sub(leaves.slice(k), m - k, false), root(leaves.slice(0, k))];
}

/** Proof that the tree of size m is a prefix of the tree of size n. */
export function consistencyProof(leaves, m, n) {
  if (m < 1 || m > n || n > leaves.length) throw new Error("bad sizes");
  if (m === n) return [];
  return sub(leaves.slice(0, n), m, true);
}

/**
 * Verify an inclusion proof for `leaf` at `index` in a tree of size `size`
 * against `expectedRoot`, without rebuilding the whole tree — the browser
 * never has every leaf, only the proof it was handed. Recomputes the root by
 * folding siblings the same way `LeafVerifier.verifyLeaf` does on chain.
 */
export function verifyInclusion(leaf, index, size, proof, expectedRoot) {
  if (size < 1) return false;
  if (index < 0 || index >= size) return false;
  const node = fold(leaf, index, size, proof, 0);
  if (node === null) return false;
  return node.node === expectedRoot && node.used === proof.length;
}

/** Recursive fold mirroring `inclusionProof`'s recursion, consuming siblings leaf-to-root. */
function fold(leaf, index, size, proof) {
  function go(idx, n, depth) {
    if (n === 1) return { node: leaf, used: 0 };
    const k = split(n);
    if (idx < k) {
      const left = go(idx, k, depth + 1);
      if (left === null) return null;
      const sibIdx = left.used;
      if (sibIdx >= proof.length) return null;
      return { node: hashNode(left.node, proof[sibIdx]), used: left.used + 1 };
    } else {
      const right = go(idx - k, n - k, depth + 1);
      if (right === null) return null;
      const sibIdx = right.used;
      if (sibIdx >= proof.length) return null;
      return { node: hashNode(proof[sibIdx], right.node), used: right.used + 1 };
    }
  }
  return go(index, size, 0);
}

/**
 * Verify a consistency proof: the tree of size `m` (whose root is
 * `rootM`) is a prefix of the tree of size `n` (whose root is `rootN`).
 *
 * This is the standard bit-decomposition algorithm for RFC 6962 §2.1.2
 * consistency proofs (as implemented by, e.g., Certificate Transparency's
 * own verifiers) rather than a literal inversion of `consistencyProof`'s
 * recursion — the prover has the full leaf list and can compute an
 * arbitrary subtree root directly (`sub()` does exactly that); the
 * verifier only ever has the proof array, so it must fold two running
 * roots (`node1` for size `m`, `node2` for size `n`) as it walks the
 * shared bits of `m-1` and `n-1`. Cross-checked against
 * `packages/protocol/src/log.ts` for every (m, n) pair with 1 ≤ m ≤ n ≤
 * 64 in `verify.test.mjs`.
 */
export function verifyConsistency(m, n, proof, rootM, rootN) {
  if (m < 1 || m > n) return false;
  if (m === n) return proof.length === 0 && rootM === rootN;
  if (proof.length === 0) return false;

  let fn = BigInt(m - 1), sn = BigInt(n - 1);
  while (fn % 2n === 1n) { fn >>= 1n; sn >>= 1n; }

  let p = proof.slice();
  let node1, node2;
  if (fn > 0n) {
    node1 = p[0]; node2 = p[0]; p = p.slice(1);
  } else {
    node1 = rootM; node2 = rootM;
  }

  while (p.length > 0) {
    if (sn === 0n) return false; // proof too long
    if (fn % 2n === 1n || fn === sn) {
      node1 = hashNode(p[0], node1);
      node2 = hashNode(p[0], node2);
      while (fn % 2n === 0n && fn !== 0n) { fn >>= 1n; sn >>= 1n; }
    } else {
      node2 = hashNode(node2, p[0]);
    }
    fn >>= 1n; sn >>= 1n;
    p = p.slice(1);
  }
  if (sn !== 0n) return false; // proof too short
  return node1 === rootM && node2 === rootN;
}

/* ------------------------------------------------------------------ *
 * §10.2 — Sparse Merkle revocation tree (compact-proof fold only)
 * ------------------------------------------------------------------ */

export const SMT_ZERO = ZERO32;
export const SMT_DEPTH = 256;

const smtHashNode = (l, r) =>
  l === SMT_ZERO && r === SMT_ZERO ? SMT_ZERO : keccak256(l + r.slice(2));

const bitAt = (key, i) => Number((BigInt(key) >> BigInt(i)) & 1n);

/** Fold a value up its key path — mirrors `SparseTree.computeRoot` / the contract's own walk. */
export function computeRoot(key, value, bitmap, siblings) {
  let node = value;
  let j = 0;
  for (let i = 0; i < SMT_DEPTH; i++) {
    let sibling = SMT_ZERO;
    if ((bitmap >> BigInt(i)) & 1n) sibling = siblings[j++];
    node = bitAt(key, i) === 1 ? smtHashNode(sibling, node) : smtHashNode(node, sibling);
  }
  if (j !== siblings.length) throw new Error("proof length mismatch");
  return node;
}
