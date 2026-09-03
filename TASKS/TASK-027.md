# T-027 — Licence: seal + purchase scripts, minimal buyer page

**Tier:** STRONG.

## Objective
Scripts a supplier and a buyer run (the W1 path), plus a minimal
`/corpus/{id}` page showing report summary, price, terms hash, and the
exact calldata a buyer wallet sends.

## Dependencies
T-006, T-015, T-016.

## Files
- Create `scripts/seal-corpus.mjs` (fetches `/corpora/{id}/seal-params`, sends `sealCorpus` from `SUPPLIER_KEY`), `scripts/license.mjs` (`approve` + `license` from `BUYER_KEY`), `scripts/download.mjs` (signs the download challenge, fetches files), `apps/web/corpus.html` + `corpus.js` (detail view; wallet flow optional via injected provider), tests (mocked `window.ethereum` for the page; Anvil for scripts).
- Test token: `MockERC20` from T-006 deployed by `Deploy.s.sol` on testnets when `DEPLOY_MOCK_USDC=true`.

## Expected behaviour
Scripts print tx hashes and the receipt fields; page shows `contains_revoked`
and requires a "terms {hash} read" tick before showing calldata.

## Acceptance
Golden demo steps 4–6.

## Security
Never asks for a private key in the browser.
