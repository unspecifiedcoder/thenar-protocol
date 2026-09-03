# T-025 — Provenance Report (JSON + PDF)

**Tier:** STRONG. Every statement must be checkable; wording via T-021 only.

## Objective
`GET /corpora/{id}/report` producing PLAN §9.6 JSON and a PDF rendered from
it, with `report_hash` and a `/verify?report=` link.

## Dependencies
T-006, T-012, T-016, T-021.

## Files
- Create `services/api/src/report/{build,render}.ts`, `templates/report.html`, tests. PDF via headless Chromium (`playwright`, pinned).

## Expected behaviour
- Every proof is verified server-side before inclusion; a failing proof aborts with 500 naming the episode (I-11).
- Anchors by `(root, size)` with chain locators; consistency proof from sealing anchor to report anchor.
- `episodes[].badges/wording` from T-021; `claims[].detail` included (thresholds visible).
- `limitations` = PLAN §22 verbatim.
- Reports immutable; regeneration = new `report_id`.

## Edge cases
Unsealed corpus → `draft: true`; revoked episodes → onset shown and `contains_revoked`.

## Tests
Report for the fixture on Anvil passes `scripts/verify-report.mjs` (T-033) — until T-033 exists, a test-local verifier implementing §10.10 steps 3–7; PDF embeds the hash.

## Acceptance
Golden demo step 6.

## Security
No payload bytes in reports.
