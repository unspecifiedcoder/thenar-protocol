# Architectural conflicts and FRONTIER decisions

Two lists. **Open frontier decisions** are known in advance and gate
specific steps; **conflicts** are filed by implementation agents that hit a
STOP CONDITION (`PLAN.md §26`). A FRONTIER-tier pass resolves each with an
ADR in `docs/ARCHITECTURE-DECISIONS.md`.

Format: `C-<n>: <task> — <what> — <options> — <status>`

## Open FRONTIER decisions (pre-registered)

- **FD-1 — T-017 dedup.v1 thresholds and enablement.** `T_exact`, `T_near`
  and whether `dedup.v1` may block L3 are set only after the fixture ROC is
  reported. Until then the check runs and emits claims with
  `result: inconclusive` for anything under `T_near` — never `fail`.
  Status: OPEN, gated on T-017 report.
- **FD-2 — T-019 sensor_consistency.v1 / sim_signature.v1 methodology and
  thresholds.** `sim_signature.v1` is indicative only in v2 (never blocks
  L3). Status: OPEN, gated on T-019 report.
- **FD-3 — T-023 attestation roots and supported-device list.** Which
  manufacturer roots are pinned; whether Quest reaches L2; TPM requirements.
  Status: OPEN, Phase D.
- **FD-4 — Terms document text and post-revocation rights language.** What
  a buyer may do with an episode after its consent onset (contractual).
  Needs counsel. Status: OPEN, blocks mainnet USDC (not testnets).
- **FD-5 — Pricing** (report fee, per-episode logging, SaaS). Status: OPEN,
  commercial, not blocking code.
- **FD-6 — Consortium / Avalanche L1.** Status: not before year 2.
- **FD-7 — Any change to `PLAN.md §10` (crypto), §11 (ABIs), §12 (paths),
  §9 (schemas).** Always FRONTIER.

## Conflicts filed by agents

(none yet)
