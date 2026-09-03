# T-031 — Observability and failure injection

**Tier:** CHEAP.

## Objective
Metrics per PLAN §20 (`prom-client`), structured logs, and fault tests
proving I-11.

## Dependencies
T-010, T-013.

## Files
`services/api/src/metrics.ts`, `services/log/src/metrics.ts`, `services/api/test/faults.test.ts`.

## Fault tests
Bundle store 500 mid-upload → no leaf; SQLite locked mid-append → rollback, same index reused; primary RPC down → proofs still served, `/anchors` marks chain unreachable; anchor tx reverted → no anchor row, lag grows; check throws → `inconclusive` claim.

## Acceptance
Tests green; `/metrics` bound to localhost or token-gated.
