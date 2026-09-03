# T-026 — `/verify` v2 with chain selector and report verification

**Tier:** STRONG. Browser-side cryptography (keccak, Ed25519, Merkle) with
no bundler; must reproduce §10.10 exactly.

## Objective
Extend `apps/web/verify.html` + JS to: pick any configured chain (and
mirrors); verify a leaf preimage (0x01–0x04); verify a pasted/linked report
JSON end to end; show consent status and level wording; verify a corpus
proof.

## Dependencies
T-005, T-009 (`chains.js`), T-021, T-025.

## Files
- Modify `apps/web/verify.html`, `apps/web/verify.js` (new; split logic out of the page), `apps/web/keccak.js`, add `apps/web/ed25519.js` (vendor `@noble/ed25519` ESM build, pinned, with hash recorded), `apps/web/merkle.js` (port of `log.ts` verify functions), tests in `apps/web/test/verify.test.mjs` (jsdom) that reuse T-008 vectors.

## Expected behaviour
- Chain selector lists `chains.js`; RPC editable; the page states which
  chain and RPC answered.
- `?report=<url>` fetches the JSON, verifies per §10.10 steps 3–7 in the
  browser (file hashes cannot be checked without files: say so), and
  renders a per-episode table with level wording from T-021's table
  (duplicated in JS; a test asserts string equality with the TS source).
- Any failing step is named; nothing is summarised as "verified" unless
  every step passed.

## Edge cases
Mirror ahead/behind primary; report generated at anchor *k* while chain is
at *k+n* (consistency proof fetched live from `/proofs/consistency`);
report for an unsealed corpus.

## Tests
jsdom tests for each leaf version; report fixture verifies; a mutated
report fails at the right step.

## Acceptance
Golden demo steps 4, 8, 9 are performed on this page.

## Security
Vendored crypto pinned by hash in `imports.test.mjs`.
