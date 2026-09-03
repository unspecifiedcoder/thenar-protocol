# T-029 — Site copy and chain-string audit

**Tier:** CHEAP. Text and configuration changes with a grep-based guard.

## Objective
Rewrite site copy to the v2 thesis and remove every hard-coded chain name.

## Dependencies
T-009 (`chains.js`), T-021 (wording).

## Files
- Modify `apps/web/index.html`, `products.html`, `protocol.html`, `market.html`, `company.html`, `faq.html`, `README.md`, `services/export/src/lerobot.ts` (`thenar.chain` from config), `apps/web/grasp-chain.js` (rename `MONAD` export to `CHAIN`; all pages).
- Create `apps/web/test/copy.test.mjs`.

## Expected behaviour
- Tagline: "Provenance and rights for physical-AI data." Replace "contact
  data for physical AI" everywhere.
- `/products`: Provenance Report, Recorder SDK, Licence Registry, Consent
  Service — each with a state label (building/running) that is true.
  Band and Hotaru move to a "Hardware research" footnote with their honest
  state; Contact Audit removed.
- `/protocol`: reflect PLAN §4, §10, §11 in prose; the claim ladder table
  verbatim; "What it does not prove" retained and expanded per PLAN §22.
- `/market`: the wedge (THESIS §4.3) and pricing shape; no invented numbers.
- No page contains "Monad", "MON", or a chain id literal; chain names are
  rendered from `chains.js`.

## Tests
`copy.test.mjs` fails on: "Monad", "authentic", "contact data for physical
AI", any `0x[0-9a-f]{40}` literal outside `chains.js`, any `chainId:`
literal outside `chains.js`.

## Acceptance
Guard test in CI; TESTPLAN P-items re-run manually and recorded.
