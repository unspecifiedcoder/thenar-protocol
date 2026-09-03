import type { DatabaseSync } from "node:sqlite";
import { keccak256, type Hex } from "viem";
import { hashNode } from "../../../packages/protocol/src/log.ts";

/**
 * Cached-node RFC 6962 tree (PLAN Sec10.1) over a SQLite `node(level, idx,
 * hash)` table.
 *
 * `node(level, idx)` holds the root of the *complete* subtree spanning
 * leaves `[idx*2^level, idx*2^level + 2^level)` — written exactly once, the
 * instant that range fills. Every range the RFC 6962 split recursion ever
 * asks for is one of these complete-subtree ranges or a singleton leaf
 * (that is the standard Merkle-mountain-range property of the `split`
 * function: it always partitions `[0, n)` into left-aligned power-of-two
 * blocks) — so `root`/`inclusionProof`/`consistencyProof` below read
 * exclusively from the cache, no leaf replay, giving O(log n) queries
 * (well, O(log^2 n) worst case: each of the O(log n) split levels reads
 * O(log n) cached rows for its non-power-of-two remainder) instead of the
 * pure implementation's O(n).
 */

const EMPTY_ROOT: Hex = keccak256("0x");

function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

function log2(n: number): number {
  return Math.round(Math.log2(n));
}

/** Largest power of two strictly less than n — identical to packages/protocol/src/log.ts's `split`. */
function split(n: number): number {
  let k = 1;
  while (k * 2 < n) k *= 2;
  return k;
}

function getNode(db: DatabaseSync, level: number, idx: number): Hex | null {
  const r = db.prepare("SELECT hash FROM node WHERE level = ? AND idx = ?").get(level, idx) as { hash: string } | undefined;
  return r ? (r.hash as Hex) : null;
}

function putNode(db: DatabaseSync, level: number, idx: number, hash: Hex): void {
  db.prepare("INSERT INTO node (level, idx, hash) VALUES (?, ?, ?)").run(level, idx, hash);
}

/**
 * Called once per appended leaf, inside the same transaction as the insert
 * into `leaf`. Caches the leaf itself at level 0, then bubbles up: whenever
 * the newly written node is the *right* half of a pair whose left half is
 * already cached, the pair combines into their parent, which is itself
 * cached and checked for its own pairing one level up. A left half (or any
 * node with no sibling yet) stops the walk — that subtree is not complete
 * and won't be, until a later append fills it.
 */
export function cacheAppend(db: DatabaseSync, index: number, leafHash: Hex): void {
  putNode(db, 0, index, leafHash);
  let level = 0;
  let idx = index;
  let cur = leafHash;
  while (idx % 2 === 1) {
    const left = getNode(db, level, idx - 1);
    if (left === null) {
      throw new Error(`tree cache corrupt: missing node(${level}, ${idx - 1}) while completing a pair`);
    }
    cur = hashNode(left, cur);
    idx = (idx - 1) / 2;
    level += 1;
    putNode(db, level, idx, cur);
  }
}

/**
 * Root of leaves `[start, start+len)`. `len === 1` reads the cached leaf
 * directly; a power-of-two `len` tries the exact cache entry first (present
 * whenever `start+len <= size`, by the invariant above); anything else
 * splits exactly as the pure `root()` does and combines two sub-ranges.
 * The recursive fallback (only reached if a power-of-two range was
 * expected in cache but is not — which the invariant says cannot happen for
 * `start+len <= size`) still returns the correct root, just without the
 * O(log n) guarantee.
 */
function rangeRoot(db: DatabaseSync, start: number, len: number): Hex {
  if (len === 1) {
    const h = getNode(db, 0, start);
    if (h === null) throw new Error(`tree cache corrupt: missing leaf node(0, ${start})`);
    return h;
  }
  if (isPow2(len)) {
    const level = log2(len);
    const idx = start / len;
    const cached = getNode(db, level, idx);
    if (cached !== null) return cached;
  }
  const k = split(len);
  return hashNode(rangeRoot(db, start, k), rangeRoot(db, start + k, len - k));
}

/** Root of the first `upTo` leaves (defaults to `size`); empty log ⇒ RFC 6962's empty-tree root. */
export function root(db: DatabaseSync, size: number, upTo?: number): Hex {
  const n = upTo ?? size;
  if (n === 0) return EMPTY_ROOT;
  return rangeRoot(db, 0, n);
}

function inclusionProofRange(db: DatabaseSync, index: number, start: number, len: number): Hex[] {
  if (len === 1) return [];
  const k = split(len);
  if (index - start < k) {
    return [...inclusionProofRange(db, index, start, k), rangeRoot(db, start + k, len - k)];
  }
  return [...inclusionProofRange(db, index, start + k, len - k), rangeRoot(db, start, k)];
}

export function inclusionProof(db: DatabaseSync, index: number, size: number): Hex[] {
  if (index < 0 || index >= size) throw new Error("index out of range");
  return inclusionProofRange(db, index, 0, size);
}

function sub(db: DatabaseSync, start: number, len: number, m: number, isComplete: boolean): Hex[] {
  const n = len;
  if (m === n) return isComplete ? [] : [rangeRoot(db, start, len)];
  const k = split(n);
  if (m <= k) {
    return [...sub(db, start, k, m, isComplete), rangeRoot(db, start + k, n - k)];
  }
  return [...sub(db, start + k, n - k, m - k, false), rangeRoot(db, start, k)];
}

export function consistencyProof(db: DatabaseSync, m: number, n: number): Hex[] {
  if (m < 1 || m > n) throw new Error("bad sizes");
  if (m === n) return [];
  return sub(db, 0, n, m, true);
}
