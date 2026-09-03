import { keccak256, concatHex, toHex, type Hex } from "viem";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { root as ctRoot } from "./log";

/**
 * T-002 -- payloadHash over container files (PLAN §10.4, D-4, D-18).
 *
 * THENAR commits to a supplier's container files exactly as delivered (a
 * chunk parquet or a per-camera MP4 may hold many episodes); it never
 * slices or re-encodes (D-18). `payloadHash` is the commitment over that
 * file set.
 */

export type FileEntry = { path: string; bytes: number; hash: Hex }; // hash = keccak256(fileBytes)

/**
 * PLAN §9.1 path rule: relative, `/`-separated, no `..` segment, no leading
 * `/`, no backslash, no byte 0x1f, first byte in `[A-Za-z0-9]`; empty is
 * rejected. Checked before any filesystem access (§ Security).
 */
export function assertPath(path: string): void {
  if (path.length === 0) throw new Error("path must not be empty");
  if (path.startsWith("/")) throw new Error(`path must not have a leading /: ${path}`);
  if (path.includes("\\")) throw new Error(`path must not contain a backslash: ${path}`);
  if (path.includes("\x1f")) throw new Error(`path must not contain byte 0x1f: ${path}`);
  for (const segment of path.split("/")) {
    if (segment === "") throw new Error(`path must not contain an empty segment: ${path}`);
    if (segment === "..") throw new Error(`path must not contain a .. segment: ${path}`);
  }
  const first = path.charCodeAt(0);
  const isDigit = first >= 0x30 && first <= 0x39;
  const isUpper = first >= 0x41 && first <= 0x5a;
  const isLower = first >= 0x61 && first <= 0x7a;
  if (!isDigit && !isUpper && !isLower) {
    throw new Error(`path must start with [A-Za-z0-9]: ${path}`);
  }
}

/** `H(0x00 ‖ utf8(path) ‖ 0x1f ‖ fileHash)` — PLAN §10.4. */
export function fileLeaf(path: string, fileHash: Hex): Hex {
  assertPath(path);
  return keccak256(concatHex(["0x00", toHex(path), "0x1f", fileHash]));
}

/**
 * `ctRoot` (PLAN §10.1 node rules) over the manifest's `fileLeaf` values,
 * used directly as level-0 nodes -- no second 0x00 (§27 trap #3), because
 * `fileLeaf` already is a leaf hash. Files are sorted by `utf8(path)`
 * ascending, bytewise (`Buffer.compare`, never `localeCompare` -- §27 trap
 * #2) before the tree is built, so `payloadHash` is order-independent.
 */
export function payloadHash(files: FileEntry[]): Hex {
  if (files.length === 0) throw new Error("payloadHash requires at least one file");
  const seen = new Set<string>();
  for (const f of files) {
    assertPath(f.path);
    if (seen.has(f.path)) throw new Error(`duplicate path: ${f.path}`);
    seen.add(f.path);
  }
  const sorted = [...files].sort((a, b) =>
    Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")),
  );
  const leaves = sorted.map((f) => fileLeaf(f.path, f.hash));
  return ctRoot(leaves);
}

/**
 * Incremental keccak256 over an async byte stream -- memory-bounded, so a
 * multi-GB container file never has to sit fully in memory.
 */
export async function hashStream(stream: AsyncIterable<Uint8Array>): Promise<Hex> {
  const hasher = keccak_256.create();
  for await (const chunk of stream) {
    hasher.update(chunk);
  }
  return `0x${Buffer.from(hasher.digest()).toString("hex")}` as Hex;
}

/** Wraps an async byte stream, counting bytes as they pass through. */
async function* countingTee(
  stream: AsyncIterable<Uint8Array>,
  counter: { bytes: number },
): AsyncIterable<Uint8Array> {
  for await (const chunk of stream) {
    counter.bytes += chunk.length;
    yield chunk;
  }
}

/**
 * Reads `relPaths` under `root` on disk, hashing each with `hashStream` and
 * recording its size. Every path is validated by `assertPath` before any
 * filesystem access. The byte count observed while streaming must match
 * `fs.stat`'s reported size, or the read raced a concurrent write and the
 * entry is rejected rather than silently committed to a torn file.
 */
export async function buildFileEntries(root: string, relPaths: string[]): Promise<FileEntry[]> {
  const entries: FileEntry[] = [];
  for (const relPath of relPaths) {
    assertPath(relPath);
    const absPath = resolvePath(root, relPath);
    const st = await stat(absPath);
    const counter = { bytes: 0 };
    const hash = await hashStream(countingTee(createReadStream(absPath), counter));
    if (counter.bytes !== st.size) {
      throw new Error(
        `buildFileEntries: ${relPath} byte count mismatch (streamed ${counter.bytes}, stat ${st.size})`,
      );
    }
    entries.push({ path: relPath, bytes: counter.bytes, hash });
  }
  return entries;
}
