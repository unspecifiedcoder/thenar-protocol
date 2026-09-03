# T-032 — Static analysis, invariant tests, review pack

**Tier:** CHEAP. Tooling and documentation.

## Objective
Add Slither and Foundry invariant tests to CI; assemble the external-review
pack.

## Dependencies
Phase A complete.

## Files
- Modify `.github/workflows/ci.yml` (Slither job with `--fail-high`; `forge test --match-path 'test/invariant/*'`; gas snapshot diff).
- Create `packages/contracts/test/invariant/{Log,Registry}.invariant.t.sol`.
- Create `docs/REVIEW-PACK.md`: contract list, ABIs, trust model (PLAN §6), threat model (§7), known limitations (§22), test commands, deployment addresses.

## Invariants (Foundry handlers)
- `GraspLog`: for all anchors `i<j`: `size_i < size_j`, `root_i != root_j`, `prevRoot_j == root_{j-1}`.
- `LicenceRegistry`: sum of amounts in `Licensed` events == sum of payouts + credited; `credited` never decreases except via `withdraw`; no receipt references a corpus that was never sealed.

## Acceptance
CI has the jobs; invariants run 10k calls locally without failure; pack
reviewed by the founder.
