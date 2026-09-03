# T-033 — Golden demo + offline verifier CLI

**Tier:** STRONG.

## Objective
`scripts/golden.mjs` executing PLAN §21 steps 1–8 unattended against Fuji +
Sepolia (or two Anvils with `--local`), and `scripts/verify-report.mjs`
implementing §10.10 against files on disk + a report JSON.

## Dependencies
T-025, T-026, T-027.

## Files
- Create `scripts/golden.mjs`, `scripts/verify-report.mjs`; delete `scripts/e2e.mjs`, `scripts/verify-sample.mjs`, `scripts/export-corpus.mjs`; `package.json` `demo:golden`, `verify:report`.

## Expected behaviour
Each step asserts its §21 outcome and prints tx hashes and proof sizes; the
jittered episode is produced by adding N(0, 1°) to episode 2's state and
written as a *separate fixture dataset* marked `source_uri: "fixture://jitter"`;
step 7 anchors a revocation-only head; step 8 flips one byte of a downloaded
parquet and the verifier names the file and leaf. Writes
`apps/web/samples/golden-report.json`.

## Acceptance
"8/8 steps passed" on two consecutive clean runs; CI nightly with `continue-on-error`.

## Security
Testnet keys only; never printed.
