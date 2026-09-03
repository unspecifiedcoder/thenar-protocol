# T-005 — GraspLog anchor rule (D-17), `indexOfRoot`, `verifyLeafHash`; LeafVerifier 0x01–0x04

**Tier:** STRONG. Contract change to the head rule (I-2) — fully specified in
PLAN §11.1; no design latitude.

## Objective
1. Replace `GraspLog.anchor`'s strict-growth rule with D-17 so a
   revocation-only head can be anchored; add `indexOfRoot`; add
   `verifyLeafHash`; remove `verifyClip`.
2. Extend `LeafVerifier` to versions 0x03/0x04 with `corpusFacts`/`claimFacts`.

## Context
`scripts/e2e.mjs:136` forged `size+1` with a 7-leaf root to anchor a
revocation — the defect this fixes. That script is deleted in T-033.

## Dependencies
T-003.

## Files
- Modify `packages/contracts/src/GraspLog.sol`, `src/LeafVerifier.sol`, `test/GraspLog.t.sol`, `test/LeafVerifier.t.sol`.
- Modify `apps/web/verify.html` only to call `LeafVerifier.verifyLeaf` instead of `verifyClip` (selector from `cast sig`).
- Modify `packages/protocol/src/log.ts`: `consistencyProof(leaves, m, n)` must accept `m == n` and return `[]` (currently throws only when `m > n`; verify).

## Interfaces
```solidity
// GraspLog
error SizeMustNotShrink(uint64 head, uint64 next); error RootMustChange(); error RootMustMatchAtSameSize(); error NothingToAnchor();
function anchor(bytes32 root, uint64 size, bytes32 revocationRoot) external returns (uint256);
function indexOfRoot(bytes32 root) external view returns (bool found, uint256 index);   // first anchor with this root
function verifyLeafHash(uint256 index, bytes32 leaf, bytes32[] calldata proof, uint64 leafIndex) external view returns (bool);
// LeafVerifier
function corpusFacts(bytes calldata p) external pure returns (bytes32 manifestHash, bytes32 corpusRoot, bytes32 termsHash, bytes32 taskId, uint64 episodeCount, uint64 sealedAt);
function claimFacts(bytes calldata p) external pure returns (bytes32 subjectLeaf, bytes32 verifierKeyId, uint16 checkId, uint8 result, uint8 level, uint64 issuedAt);
```

## Expected behaviour (anchor rule matrix — test every cell)
| size vs head | root | revocationRoot | outcome |
| --- | --- | --- | --- |
| first anchor, size 0 | — | — | `SizeMustGrow(0,0)` (keep existing error) |
| < | any | any | `SizeMustNotShrink` |
| > | same | any | `RootMustChange` |
| > | changed | same or changed | accepted |
| == | changed | any | `RootMustMatchAtSameSize` |
| == | same | same | `NothingToAnchor` |
| == | same | changed | accepted; `prevRoot = root` |

`_indexOfRoot[root]` set only on first occurrence (equal-size anchors reuse
the root; `indexOfRoot` returns the first).

## Constraints
No storage layout compatibility needed (fresh deploy). Gas for `verifyLeaf`
with a 20-deep proof < 120k (record in report).

## Tests
Matrix above; `indexOfRoot` first-occurrence; `verifyLeafHash` for each
version using T-008 vectors; truncation/extension by one byte reverts;
`revocationOnset` across an equal-size anchor pair (present at *i*, absent at
*i−1* where `size_i == size_{i−1}`).

## Acceptance
`forge test` green; gas noted; `/verify` sample still verifies against a
local Anvil deploy.

## Security
Equal-size anchors must not allow a root swap (row 5). Version/length
disagreement reverts before hashing.
