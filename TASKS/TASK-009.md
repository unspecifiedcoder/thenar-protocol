# T-009 — Deploy scripts, `.env.contracts`, `chains.js`, selector test

**Tier:** CHEAP.

## Objective
Deploy to Fuji (primary) and Sepolia (mirror); produce machine-readable
addresses; generate `apps/web/chains.js`; guard hand-written selectors.

## Dependencies
T-005, T-006, T-007.

## Files
- Modify `packages/contracts/foundry.toml` (add `sepolia` rpc + etherscan), `script/Deploy.s.sol` (`ROLE` env: primary deploys all three; mirror deploys `GraspLog` + `LeafVerifier` only), root `package.json` (`deploy:fuji`, `deploy:sepolia`, `gen:chains`).
- Create `.env.contracts.example`:
  ```
  CHAIN_43113_ROLE=primary  CHAIN_43113_LOG=0x…  CHAIN_43113_VERIFIER=0x…  CHAIN_43113_REGISTRY=0x…  CHAIN_43113_RPC=https://…  CHAIN_43113_FROM_BLOCK=…
  CHAIN_11155111_ROLE=mirror  CHAIN_11155111_LOG=0x…  CHAIN_11155111_VERIFIER=0x…  CHAIN_11155111_RPC=https://…
  ```
- Create `scripts/gen-chains.mjs` → `apps/web/chains.js` (`export const CHAINS = [{ id, name, role, rpc, explorer, log, verifier, registry? }]`).
- Create `packages/protocol/test/selectors.ts`: derive selectors from `packages/contracts/out/*.json` ABIs with viem and compare to every `0x[0-9a-f]{8}` selector literal in `apps/web/*.js`.
- Modify `apps/web/grasp-chain.js` to import `CHAINS` and drop the `MONAD` export (pages updated in T-029; keep a temporary `CHAIN = CHAINS[0]` export so pages keep working until then).

## Acceptance
Both chains deployed and source-verified; `.env.contracts` filled;
`gen:chains` output committed and diff-checked in CI; selector test green.

## Security
Keys stay in `.env.deployer` (ignored).
