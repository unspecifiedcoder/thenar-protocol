# T-008 — Vectors: TS → Solidity + JSON; CI diff guard

**Tier:** CHEAP. Extend the generator; regenerate; wire the guard.

## Objective
Emit deterministic vectors for: leaves 0x01–0x04, `fileLeaf`/`payloadHash`
(3 fixture files), JCS fixtures, `manifestHash` (fixture manifest, with and
without signature), `consentKey`/`consentCommitment`/`revocationValue`, the
four signature messages, the §10.12 manifest→leaf mapping, and one Ed25519
and one P-256 signature with fixed test keys.

## Dependencies
T-002, T-003, T-004, T-035.

## Files
- Modify `packages/protocol/test/vectors.ts` → writes `packages/contracts/test/Vectors.sol` **and** `packages/protocol/test/fixtures/vectors.json`.
- Create `packages/protocol/test/fixtures/{manifest.json, files/a.txt, files/b.bin, files/sub/c.parquet}` (small, committed).
- Modify `.github/workflows/ci.yml`: after `pnpm vectors`, `git diff --exit-code packages/contracts/test/Vectors.sol packages/protocol/test/fixtures/vectors.json`.
- Modify the Solidity tests that consume vectors.

## Expected behaviour
No `Date.now()`/randomness; fixed keys are test-only and named as such.
Solidity tests recompute `fileLeaf` and `payloadHash` from the vector inputs
(port of §10.4 in a test helper) to prove language independence.

## Acceptance
`pnpm vectors && git diff --exit-code …` passes in CI; all suites green.

## Security
Vectors are the only guarantee the implementations agree (I-5).
