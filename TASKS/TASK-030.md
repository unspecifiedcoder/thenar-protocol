# T-030 — Adversarial test suite

**Tier:** STRONG. Writing attacks requires understanding the protocol; the
attack list is fixed here.

## Objective
One suite (`pnpm test:adversarial`) that attempts each PLAN §7 threat
against the TS reference, the Solidity, and the API, and asserts every
attempt is refused with the expected error.

## Dependencies
Phase A complete; T-010–T-012; T-020.

## Files
- Create `packages/protocol/test/adversarial.ts`, `packages/contracts/test/Adversarial.t.sol`, `services/api/test/adversarial.test.ts`.

## Attacks (each is one named test)
1. Inclusion proof with a sibling moved to the other side (must fail; side derives from index).
2. Proof padded with one extra sibling / truncated by one.
3. Leaf index ≥ size; size 0.
4. Consistency proof from a *different* log with the same size.
5. Interior node presented as a leaf (0x01-prefixed value passed as preimage hash).
6. SMT non-membership proof for a key that is present (must fail); membership with zero value (revert `ZeroLeafValue`).
7. Onset proof where the key is also present at `index−1`.
8. Anchor with `size` equal / `root` unchanged (contract reverts).
9. Revocation with a signature from a different key; with the manifest domain; replayed for a different consent key.
10. Manifest with `signature` mutated after signing; manifest with a key not valid at `captured_at`.
11. Episode resubmitted with jitter σ = 0.5° (must hit `dedup.v1 = fail`).
12. Manifest `source:"real"` over the sim fixture (must hit `sim_signature.v1 = fail` or `inconclusive`, never L3).
13. A 145-byte preimage whose version byte is 0x04, and a 141-byte one whose version byte is 0x03 (both revert `WrongLengthForVersion`, never parse).
14. `sealCorpus` with a corpus manifest never logged; with a proof for a different leaf; with each `SealParams` field mismatched (`FactsMismatch(i)`).
15. `license` on retired terms; on a closed corpus; with insufficient allowance; anchor-rule matrix from T-005 (shrink, equal-size root swap, nothing-to-anchor).
16. API: idempotency key reuse with a changed body; API key of org A on org B's corpus; download signature by non-buyer.
17. Chain-id injection: a manifest containing `chain_id` must be rejected by schema (I-7).

## Acceptance
All 17 pass (i.e., all attacks refused); listed in CI.

## Security
This suite is the regression guard for I-10; any future refactor of the
listed libraries must keep it green.
