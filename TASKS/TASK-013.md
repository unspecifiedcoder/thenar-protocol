# T-013 — Anchor scheduler daemon and lag alarm

**Tier:** CHEAP.

## Objective
A long-running process that anchors the head per chain at its cadence —
including revocation-only heads (D-17) — with backoff and lag metrics.

## Dependencies
T-007, T-014.

## Files
- Create `services/log/src/daemon.ts`, `test/daemon.test.ts` (fake clock, fake anchorer); `package.json` `log:daemon`.

## Expected behaviour
- Anchors when `store.size() > lastAnchoredSize(chain)` **or**
  `revocationRoot(store) != lastAnchoredRevocationRoot(chain)`.
- Intervals per role (`primary` 3600 s, `mirror` 86400 s); backoff 30 s → 5 min.
- Records `anchor_chain` rows with `(root, size)` → `(chainId, index, block, tx)`.
- Alarm (error log + optional webhook) when lag > 2× interval or T-007 divergence.

## Tests
Fake clock: one anchor per interval; revocation-only anchor; backoff; alarm.

## Acceptance
Runs for 3 simulated hours against two Anvils in test.
