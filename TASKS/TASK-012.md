# T-012 — Proof and consent endpoints

**Tier:** CHEAP. Route wiring over store functions; behaviour fixed in PLAN §12.

## Objective
Implement `GET /episodes/{leafHash}`, `GET /proofs/inclusion`,
`GET /proofs/consistency`, `GET /consent/{consentKey}`,
`POST /consent/{consentKey}/revoke`, `GET /anchors`, `GET /anchors/audit`.

## Dependencies
T-036 (episodes exist), T-004, T-014.

## Files
- Modify `services/api/src/routes/{proofs,consent,anchors,episodes}.ts`; tests `services/api/test/proofs.test.ts`.

## Expected behaviour
- Anchors are addressed by `(root, size)`; the store resolves them to
  chain locators. Unknown `(root,size)` → 404.
- Inclusion: computed against the anchor's `size`; leaf index ≥ size → 404
  "leaf N is not covered by anchor (size M)".
- Consistency: `from_size ≤ to_size` else 400; equal → `{proof: []}`.
- Consent status: SMT built from revocations whose `firstAnchor.size ≤
  anchor size`; `pending` when a revocation is received but not anchored.
- Revoke: verifies via `store.revoke`; returns a signed receipt
  (`kind: "revocation_receipt"`, same signing rule as append receipts).
- `/anchors`: every chain from `.env.contracts`; `/anchors/audit` runs
  `auditAnchors` per chain.

## Tests
Round-trip every proof through TS verifiers and Solidity on Anvil; bad
signature → 401; pending state; equal-size consistency.

## Acceptance
Routes documented in `openapi.json`; tests green.

## Security
Never return a proof for a size the chain has not anchored (I-11).
