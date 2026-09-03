# T-006 — LicenceRegistry (token-only, terms by hash, receipt before payout)

**Tier:** STRONG. Money-handling Solidity; fully specified in PLAN §11.3
(D-22, D-27).

## Objective
Implement `LicenceRegistry`; delete `GraspMarket.sol`, `FoundryMarket.sol`,
`TaskRegistry.sol`, their tests and `script/DeployFoundry.s.sol`,
`script/DeployVerifier.s.sol`.

## Dependencies
T-003, T-005.

## Files
- Create `packages/contracts/src/LicenceRegistry.sol`, `test/LicenceRegistry.t.sol`, `test/mocks/MockERC20.sol` (variants: standard, returns-false, no-return-value, reverts).
- Delete the files listed above; update `test/Vectors.sol` consumers if any referenced them.
- Modify `packages/contracts/script/Deploy.s.sol` to deploy `GraspLog(relayer)`, `LeafVerifier(log)`, `LicenceRegistry(log, verifier, treasury)`.

## Interface
Exactly PLAN §11.3 (structs, functions, events, errors). `constructor(GraspLog log_, LeafVerifier verifier_, address treasury_)`; `steward = msg.sender`.

## Expected behaviour
- `sealCorpus` performs checks in the listed order; `FactsMismatch(uint8 field)` uses field index 0..3 in the order `corpusManifestHash, corpusRoot, termsHash, episodeCount`.
- `license`: **receipt pushed and `Licensed` emitted before `_pay`**; `transferFrom` via low-level call accepting empty return data; split 250 bps to treasury, remainder to supplier; `_pay` credits on failure keyed `(who, token)`.
- `withdraw(token)` pays `credited[msg.sender][token]` via `transfer`; reverts `NothingCredited` if zero; if the transfer fails, reverts (no re-credit loop).
- Two-step steward transfer (`transferSteward` → `acceptSteward`).

## Constraints
No `payable`; no proxy; no OpenZeppelin (keep the repo dependency-free; mirror its style).

## Edge cases
6-decimal token amounts (wei-exact split fuzz); terms retired after seal →
`license` reverts `TermsRetired`; corpus closed → `CorpusClosed`;
supplier that reverts on `transfer` → credited; sealing the same manifest
twice is allowed (two corpora) — document, do not block.

## Tests
Every revert path; every event; fuzz split exactness; each mock-token
variant; receipt fields; `sealCorpus` with a proof for a different leaf,
a wrong `anchorIndex`, and each facts field mismatched; reentrancy attempt
from a malicious supplier `transfer` hook cannot alter the receipt or double-pay.

## Acceptance
`forge test` green; `Deploy.s.sol` deploys the three contracts on Anvil.

## Security
`sealCorpus` is the only bridge between the log and money; it must never
accept a manifest hash the log has not anchored.
