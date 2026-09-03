# T-015 — Uploads, content-addressed bundle store, receipt-gated delivery

**Tier:** STRONG.

## Objective
`POST /uploads` + `PUT /uploads/{hash}` (local) / presigned PUT (S3);
`BundleStore` interface with local-disk and S3 implementations; receipt-gated
`GET /licences/{receiptId}/download`.

## Dependencies
T-002, T-010; chain reads via T-016 (stub with direct RPC until then).

## Files
- Create `services/api/src/store/bundle.ts` (interface, `LocalBundleStore`, `S3BundleStore`), `src/routes/{uploads,licences}.ts`, tests.
- Dep: `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`.

## Interfaces
```ts
export interface BundleStore { put(hash: Hex, stream: AsyncIterable<Uint8Array>, bytes: number): Promise<void>; has(hash): Promise<boolean>; open(hash): Promise<ReadableStream>; signedGetUrl(hash, ttlS): Promise<string>; signedPutUrl?(hash, bytes, ttlS): Promise<string>; }
```

## Expected behaviour
- `put` streams to a temp key, verifies keccak == `hash` and length == `bytes`, then renames; mismatch → 422 `hash_mismatch`, temp deleted.
- `POST /uploads` returns `{stored: true}` if already present; else the PUT target and `expires_at`.
- `upload` table rows: `pending` → `stored` on verified completion (S3: a completion callback `POST /uploads/{hash}/complete` that verifies by streaming the object).
- Download: verify EIP-191 signature (window ±2 min); read `receiptAt` from primary (mirror fallback); `receipt.buyer == signer`; return files for every episode in the corpus with 15-minute signed URLs.

## Edge cases
Duplicate concurrent uploads of the same hash (second waits or returns
`stored`); missing object for a delivered corpus → 500 naming the hash
(never a substitute).

## Tests
Local store: mismatch rejected; idempotent; streaming 100 MB fixture within memory bounds. Download: valid / wrong buyer 403 / expired 401.

## Acceptance
T-011 reads from this store; golden demo step 6.

## Security
Signed URLs are bearer tokens: short TTL, per-file, logged.
