# T-007 — Anchorer stewardship: relayer key, Safe control, mirror anchoring

**Tier:** STRONG. Key-management and multi-chain write path (D-9, D-10).

## Objective
Separate the anchoring relayer key from stewardship, make the anchorer
transferable to a Safe, and anchor the same head to a primary and a mirror
chain with divergence detection.

## Dependencies
None (contracts unchanged except deployment wiring).

## Files
- Modify `services/log/src/anchorer.ts`, `services/log/src/chain.ts` → `chains.ts`
- Create `services/log/src/mirror.ts`
- Modify `services/log/src/cli.ts` (`anchor --chain <id>|all`, `audit --chain`)
- Modify `services/log/test/log.test.ts` (use Anvil via `anvil --port` in test or a fake client interface)

## Interfaces
```ts
export type ChainTarget = { id: number; name: string; rpc: string; log: Hex; confirmations: number; role: "primary" | "mirror" };
export function loadChains(): ChainTarget[];              // from .env.contracts (T-009)
export async function anchorHead(store, target: ChainTarget, signer): Promise<AnchorResult | null>;
export async function anchorAll(store, signer): Promise<AnchorResult[]>;   // primary first; mirrors anchor the same (root,size,revRoot)
export async function checkDivergence(store, targets): Promise<{ chainId: number; index: number; detail: string }[]>;
```

## Expected behaviour
- Relayer key: `ANCHOR_RELAYER_KEY` env; deployer key no longer used for
  anchoring. `Deploy.s.sol` (T-009) sets `anchorer = relayer`, then calls
  `transferAnchorer(safe)` only when `SAFE_ADDRESS` is set, and documents
  that the Safe must call `acceptAnchorer()` and can re-delegate.
- Mirrors anchor the *same* `(root, size, revocationRoot)`; if a mirror is
  behind by more than one head it catches up by anchoring only the latest
  head (consistency proofs still work — the log is the same).
- `checkDivergence` flags any chain whose anchor at a given size has a
  different root from the primary's.
- Gas: keep the 200k limit; remove Monad comments.

## Constraints
No chain id in any leaf (I-7). Anchor cadence configured per chain.

## Edge cases
Primary succeeds, mirror tx reverts → record primary, alert, retry mirror
later; RPC timeout → no store write.

## Tests
Two Anvil instances (or a fake `PublicClient`/`WalletClient` pair) —
anchor to both, verify equal heads; simulate mirror lag; simulate a
divergent mirror and assert detection.

## Acceptance
`pnpm log anchor --chain all` works against two local Anvils; audit shows
both coherent.

## Security
Relayer key can only call `anchor()`; loss of it cannot rewind (contract),
and the Safe can replace it. Document the runbook in `docs/OPERATIONS.md`.
