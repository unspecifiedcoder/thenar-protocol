# T-035 — Manifest/corpus/claim schemas, validation, manifest→leaf mapping

**Tier:** STRONG. The single place where JSON becomes leaf bytes (PLAN §9,
§10.12); every trap in §27 rows 1, 7, 19 lives here.

## Objective
In `packages/protocol`: zod schemas for CaptureManifest, CorpusManifest,
VerificationClaim, ConsentRecord, AppendReceipt (closed, sorted-array rules
enforced); hashing helpers; the normative `manifestToEpisode()` mapping.

## Dependencies
T-001, T-002, T-003, T-004.

## Files
- Create `packages/protocol/src/schemas.ts`, `packages/protocol/src/mapping.ts`, `packages/protocol/test/schemas.ts` (register).
- Dep: `zod` in `packages/protocol`.

## Interfaces
```ts
export const CaptureManifestSchema, CorpusManifestSchema, VerificationClaimSchema, ConsentRecordSchema, AppendReceiptSchema;   // zod, .strict()
export function validateManifest(m: unknown): { ok: true; value: CaptureManifest } | { ok: false; issues: Issue[] };
export function manifestHash(m: CaptureManifest): Hex;                   // hashObjectExcluding(m, ["signature"])
export function corpusManifestHash(m: CorpusManifest): Hex;
export function manifestToEpisode(m: CaptureManifest, submittedAt: bigint): Episode;   // §10.12, returns the 0x02 struct
export function corpusRootOf(episodeLeafHashes: Hex[]): Hex;             // §10.7, requires ascending log index (caller passes in order)
```

## Expected behaviour
- Rejects: unknown keys (incl. `chain_id`); `files[]`/`channels[]` unsorted or duplicate; bad path (§9.1 rule); `range` missing when `layout == "chunked"`; `sim.world_seed` not a decimal string fitting uint64; `payload_hash` ≠ `payloadHash(files)`; `episodes[]` in a corpus manifest with duplicates.
- Mapping exactly per §10.12 (each row is a test).

## Tests
One valid fixture per schema; each rejection; mapping table rows; vectors from T-008.

## Acceptance
`pnpm test:protocol` green; T-010 imports these schemas.

## Security
Closed schemas are the I-7 guard; do not loosen with `.passthrough()`.
