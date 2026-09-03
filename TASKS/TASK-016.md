# T-016 — Chain reads with cache (no indexer; D-29)

**Tier:** CHEAP.

## Objective
`services/api/src/chain.ts`: viem public clients per chain from
`.env.contracts`; typed reads `anchorCount`, `anchorAt`, `indexOfRoot`,
`corpusAt`, `receiptAt`, `receiptsOf`, `termsAt`; 15 s in-memory cache;
`GET /corpora/{id}` on-chain block and `contains_revoked` computed from the
store.

## Dependencies
T-009, T-010.

## Files
- Create `services/api/src/chain.ts`, `test/chain.test.ts` (Anvil deploy via `forge script` in test setup, or a fake transport replaying fixtures).

## Expected behaviour
Primary first, mirror fallback for `GraspLog` reads; `LicenceRegistry`
reads primary only; RPC failure → `unreachable` in responses, never a
cached stale value older than 15 s presented as live without a `stale_at`.

## Acceptance
`GET /corpora/{id}` and `/anchors` use this module; tests green.
