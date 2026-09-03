# T-002 — payloadHash over container files

**Tier:** STRONG. Fixed rule (PLAN §10.4, D-18) on the commitment path;
byte ordering and streaming matter.

## Objective
Compute `payloadHash` exactly per PLAN §10.4 from a manifest's `files[]`, and
build `FileEntry` lists from a directory with streaming keccak.

## Context
Episodes commit to the supplier's container files *as delivered* (a chunk
parquet and one MP4 per camera may each hold many episodes) plus a `range`
in the manifest. THENAR never slices or re-encodes (D-18).

## Dependencies
T-001.

## Files
- Create `packages/protocol/src/payload.ts`, `packages/protocol/test/payload.ts` (register in `package.json` `test:protocol` and `test/ci.ts`).
- Modify `packages/protocol/src/index.ts`; add `@noble/hashes` to `packages/protocol/package.json`.

## Interfaces
```ts
export type FileEntry = { path: string; bytes: number; hash: Hex };   // hash = keccak256(fileBytes)
export function assertPath(path: string): void;                       // PLAN §9.1 path rule; throws
export function fileLeaf(path: string, fileHash: Hex): Hex;           // H(0x00 ‖ utf8(path) ‖ 0x1f ‖ fileHash)
export function payloadHash(files: FileEntry[]): Hex;                 // sort by utf8(path) bytes asc; ctRoot over fileLeaf as level-0 nodes
export async function hashStream(stream: AsyncIterable<Uint8Array>): Promise<Hex>;   // incremental keccak_256
export async function buildFileEntries(root: string, relPaths: string[]): Promise<FileEntry[]>;
```

## Expected behaviour
- `payloadHash` uses `log.ts` `root()` over the file leaves **without** an
  extra 0x00 (they are already leaf-hashed). One file ⇒ its `fileLeaf`.
- Throws on: zero files; duplicate `path`; path violating §9.1 (absolute,
  `..`, `\`, byte 0x1f, first byte not `[A-Za-z0-9]`).
- Sorting is bytewise on UTF-8 (`Buffer.compare`), never `localeCompare`.
- Streaming: memory-bounded for multi-GB files.

## Constraints
No zip/tar; no writes; no new deps beyond `@noble/hashes`.

## Edge cases
Non-ASCII paths (sorted by bytes); same content at two paths (two leaves);
`bytes` mismatch with actual size → `buildFileEntries` throws.

## Tests
- Fixed vectors: three files with known bytes → hard-coded `fileLeaf`s and
  `payloadHash` (T-008 re-emits them).
- Property: any permutation of `files[]` gives the same `payloadHash`.
- Any single-byte change in any file changes the hash.
- `hashStream` equals `keccak256(buffer)` for lengths 0, 1, 135, 136, 137, 1 MiB.
- Each path-rule rejection.

## Acceptance
Tests pass; `pnpm payload <dir>` prints `files[]` and the hash.

## Security
Path traversal rejected before any filesystem access. The 0x1f separator
plus the first-byte rule make `path‖hash` unambiguous and keep file leaves
from ever matching a log-leaf preimage shape.
