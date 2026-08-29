import { keccak256, concatHex, type Hex } from "viem";

/**
 * Sparse Merkle tree over a 256-bit key space, for revocations.
 *
 * A buyer does not need to prove a clip was revoked — they need to prove it was
 * not, as of a given root. An inclusion list cannot express absence; a sparse
 * tree can, because every key has a defined path whether or not it was written.
 *
 * Empty subtrees are the zero word at every level (H(0,0) = 0), which collapses
 * an empty tree to a constant and makes a non-membership proof the same shape
 * as a membership one. Sound as long as no real leaf is zero, which `set`
 * refuses.
 */
export const ZERO = `0x${"00".repeat(32)}` as Hex;
export const DEPTH = 256;

export const hashNode = (l: Hex, r: Hex): Hex =>
  l === ZERO && r === ZERO ? ZERO : keccak256(concatHex([l, r]));

const bitAt = (key: Hex, i: number): number =>
  Number((BigInt(key) >> BigInt(i)) & 1n);

type Layer = Map<string, Hex>;

export class SparseTree {
  private leaves = new Map<string, Hex>();

  set(key: Hex, value: Hex) {
    if (value === ZERO) throw new Error("a real leaf may not be zero");
    this.leaves.set(BigInt(key).toString(), value);
  }

  has(key: Hex) {
    return this.leaves.has(BigInt(key).toString());
  }

  /**
   * Every level, bottom-up. Only populated paths are materialised; anything
   * absent is ZERO by construction, so this stays O(keys × depth) rather than
   * O(2^256).
   */
  private layers(): Layer[] {
    const out: Layer[] = [new Map(this.leaves)];
    for (let level = 0; level < DEPTH; level++) {
      const below = out[level];
      const parents = new Set<string>();
      for (const path of below.keys()) parents.add((BigInt(path) >> 1n).toString());
      const up: Layer = new Map();
      for (const p of parents) {
        const pb = BigInt(p);
        const l = below.get((pb * 2n).toString()) ?? ZERO;
        const r = below.get((pb * 2n + 1n).toString()) ?? ZERO;
        up.set(p, hashNode(l, r));
      }
      out.push(up);
    }
    return out;
  }

  root(): Hex {
    if (this.leaves.size === 0) return ZERO;
    return this.layers()[DEPTH].get("0") ?? ZERO;
  }

  /**
   * Compact proof: a bitmap marking the levels that carry a non-zero sibling,
   * plus those siblings. O(populated depth) words instead of a fixed 256.
   */
  proof(key: Hex): { bitmap: bigint; siblings: Hex[] } {
    const layers = this.layers();
    const k = BigInt(key);
    let bitmap = 0n;
    const siblings: Hex[] = [];
    for (let level = 0; level < DEPTH; level++) {
      const siblingPath = (k >> BigInt(level)) ^ 1n;
      const sib = layers[level].get(siblingPath.toString()) ?? ZERO;
      if (sib !== ZERO) {
        bitmap |= 1n << BigInt(level);
        siblings.push(sib);
      }
    }
    return { bitmap, siblings };
  }
}

/** Fold a value up its key path — the same walk the contract performs. */
export function computeRoot(
  key: Hex,
  value: Hex,
  bitmap: bigint,
  siblings: Hex[],
): Hex {
  let node = value;
  let j = 0;
  for (let i = 0; i < DEPTH; i++) {
    let sibling = ZERO;
    if ((bitmap >> BigInt(i)) & 1n) sibling = siblings[j++];
    node = bitAt(key, i) === 1 ? hashNode(sibling, node) : hashNode(node, sibling);
  }
  if (j !== siblings.length) throw new Error("proof length mismatch");
  return node;
}
