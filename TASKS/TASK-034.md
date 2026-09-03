# T-034 — Shelve the foundry (DELETE exporter, DEPRECATE `/build`, archive v1 docs)

**Tier:** CHEAP. Verdicts from `docs/REVIEW-2026-09-03.md` §16.

## Objective
- **DELETE** `services/export/` and `scripts/export-corpus.mjs` (writes datasets with null observation columns under a `v3.0` header — an I-1 liability; only its own test uses it). Remove `test:export`/`export` scripts and the CI step; update `ci.ts` guard.
- **DEPRECATE** `/build`: move `build.html`, `build.js`, `build.css` to `apps/web/lab/`; remove the Build link from the nav of the seven pages that carry it; keep `apps/web/test/build.test.mjs` pointing at the new path; add a banner "Lab — not part of the product".
- **KEEP** `taskspec.ts`, `sampler.ts`, `embodiments.ts`, `scene.js` and their tests.
- **ARCHIVE** `docs/ROADMAP.md`, `IDEAS.md`, `TESTPLAN.md`: prepend "Archived 2026-09-03 — describes v1; see PLAN.md" (do not delete; history).
- `docs/FOUNDRY.md`: prepend "Shelved (D-13)".
- README: add "Deployment history" (v1 proven on Monad testnet — addresses in `docs/PLAN-2026-08-status.md`; v2 targets Avalanche C-Chain with an Ethereum mirror) and remove Monad from the live sections.

## Dependencies
None.

## Tests
`pnpm test` green; `imports.test.mjs` passes with the new paths; no page links `/build`.

## Acceptance
All of the above; report lists deleted files.
