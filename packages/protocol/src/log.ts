import { keccak256, concatHex, type Hex } from "viem";

/**
 * RFC 6962 append-only Merkle tree — the log itself, off chain.
 *
 * The chain anchors this. The chain is not this.
 */
export const hashNode = (l: Hex, r: Hex): Hex =>
  keccak256(concatHex(["0x01", l, r]));

/** Largest power of two strictly less than n. */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

export function root(leaves: Hex[]): Hex {
  if (leaves.length === 0) return keccak256("0x");
  if (leaves.length === 1) return leaves[0];
  const k = split(leaves.length);
  return hashNode(root(leaves.slice(0, k)), root(leaves.slice(k)));
}

/** Path from `index` up to the root, siblings only, leaf-to-root order. */
export function inclusionProof(leaves: Hex[], index: number): Hex[] {
  if (index < 0 || index >= leaves.length) throw new Error("index out of range");
  if (leaves.length === 1) return [];
  const k = split(leaves.length);
  return index < k
    ? [...inclusionProof(leaves.slice(0, k), index), root(leaves.slice(k))]
    : [...inclusionProof(leaves.slice(k), index - k), root(leaves.slice(0, k))];
}

/** Proof that the tree of size m is a prefix of the tree of size n. */
export function consistencyProof(leaves: Hex[], m: number, n: number): Hex[] {
  if (m < 1 || m > n || n > leaves.length) throw new Error("bad sizes");
  if (m === n) return [];
  return sub(leaves.slice(0, n), m, true);
}

function sub(leaves: Hex[], m: number, isComplete: boolean): Hex[] {
  const n = leaves.length;
  if (m === n) return isComplete ? [] : [root(leaves)];
  const k = split(n);
  if (m <= k) {
    return [...sub(leaves.slice(0, k), m, isComplete), root(leaves.slice(k))];
  }
  return [...sub(leaves.slice(k), m - k, false), root(leaves.slice(0, k))];
}
