# T-021 — Badge engine and fixed wording

**Tier:** CHEAP. Pure function + string table; rules in PLAN §1, D-20, D-21.

## Objective
Compute an episode's badges and the exact wording every surface must use.

## Dependencies
T-020, T-024 (key lookup). Attestation (T-023) is an **optional** input.

## Files
- Create `packages/protocol/src/badges.ts`, `packages/protocol/src/wording.ts`, `packages/protocol/test/badges.ts`, `apps/web/test/wording.test.mjs` (grep guard).

## Rules
```
input: { anchored: {chain, block, size} | null, consent: {status, onset?}, signature: {keyId, org, validAtAnchor: boolean} | null,
         attestation: {level: 2, manufacturer, model} | null, claims: latest per check with config }
L0  iff anchored (else "Pending")
L1  iff signature && signature.validAtAnchor        // validity evaluated at first-anchor time (D-20)
L2  iff L1 && attestation?.level == 2
L3  iff every check with blocking=true has latest result "pass" && no check (blocking or not) has latest result "fail"
failed = every check whose latest result is "fail" (listed regardless of badges)
```
Wording: PLAN §1 table verbatim (substitutions only).

## Tests
Truth table over all input combinations; wording snapshot equals PLAN §1
strings; grep guard fails CI if `apps/web`, `services/api/src/report`
contain `authentic`, `genuine`, `proven real`, `independent`, or `verified`
outside the L3 template.

## Acceptance
Used by T-025, T-026; guard in CI.
