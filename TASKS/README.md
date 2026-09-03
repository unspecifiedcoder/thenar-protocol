# TASKS — execution order for PLAN.md v2.1

Each file is one task an implementation agent executes alone under
`PLAN.md §25–§26`. This file is the single source for **order**. Legend:
**B** blocking (nothing downstream starts until done) · **P** parallelisable
· **G** FRONTIER review gate · **✓** integration checkpoint.

## Order

```
Phase A — Protocol v2  (all STRONG/CHEAP; no frontier decision needed)
  T-001 canonical JSON                         B
    ↓
  parallel:
    T-002 payloadHash          ─┐
    T-003 leaves 0x03/0x04     ─┼→ T-035 manifest schema + leaf mapping   B
    T-004 consent + revoke     ─┘
    T-007 anchorer/mirrors (independent)        P
    ↓
  T-005 GraspLog rule D-17 + LeafVerifier       B
    ↓
  T-006 LicenceRegistry                         B
    ↓
  T-008 vectors (TS ⇄ Solidity ⇄ JSON)          B   ✓ A1: forge + protocol suites green, vectors diff-clean
    ↓
  T-009 deploy Fuji + Sepolia, chains.js        B   ✓ A2: both chains carry the same first anchor

Phase B — Log service
  T-010 API skeleton                            B
    ↓
  parallel:
    T-014 store hardening (SQLite triggers, node cache)  ─┐
    T-015 uploads + bundle store                          ─┼→ T-011 dataset reader → T-036 commit & append   B
    T-024 org + key registry                              ─┘
    ↓
  parallel:
    T-012 proofs/consent endpoints   P
    T-013 anchor daemon              P
    T-016 chain reads                P            ✓ B1: fixture dataset → leaves → anchored on both chains → proofs verify on chain

Phase C — Checks
  parallel:
    T-018 timing + kinematics        P
    T-017 dedup                      P   G FD-1 before `fail` is enabled
    T-019 consistency + sim          P   G FD-2 before `fail` is enabled
    ↓
  T-020 claim issuance               B
    ↓
  T-021 badges + wording             B            ✓ C1: fixture run yields claims; injected duplicate flagged (fail or inconclusive per FD-1)

Phase E — Wedge product
  parallel:
    T-025 report (JSON + PDF)        ─┐
    T-026 /verify v2                 ─┼→ T-033 golden demo   ✓ E1: §21 steps 1–8 unattended on Fuji + Sepolia
    T-027 licence script + page      ─┤
    T-029 copy + chain-string audit  ─┤
    T-030 adversarial suite          ─┤
    T-032 static analysis + review pack ┘

Phase D — Capture (post-wedge; optional; do not start before E1)
  T-037 devices/sessions → T-022 SDK → T-023 attestation   G FD-3

Phase F — Hygiene (any time after A1)
  T-034 shelve foundry (DELETE exporter, DEPRECATE /build)   P
  T-031 observability + fault tests                          P
```

## Table

| ID | Title | Phase | Tier | Depends on |
| --- | --- | --- | --- | --- |
| T-001 | Canonical JSON (JCS) and object hashing | A | STRONG | — |
| T-002 | payloadHash over container files | A | STRONG | T-001 |
| T-003 | Leaf 0x03 CorpusManifest (145 B) and 0x04 VerificationClaim (141 B) | A | STRONG | — |
| T-004 | Per-episode consent record, consent key, signed revocation (Ed25519 + P-256) | A | STRONG | T-001 |
| T-035 | Manifest/corpus/claim schemas, validation, manifest→leaf mapping | A | STRONG | T-001, T-002, T-003, T-004 |
| T-005 | GraspLog anchor rule (D-17), `indexOfRoot`, `verifyLeafHash`; LeafVerifier 0x01–0x04 | A | STRONG | T-003 |
| T-006 | LicenceRegistry (token-only, terms by hash, receipt before payout) | A | STRONG | T-003, T-005 |
| T-007 | Anchorer: relayer key, Safe control, mirror anchoring | A | STRONG | — |
| T-008 | Vectors: TS → Solidity + JSON; CI diff guard | A | CHEAP | T-002, T-003, T-004, T-035 |
| T-009 | Deploy scripts, `.env.contracts`, `chains.js`, selector test | A | CHEAP | T-005, T-006, T-007 |
| T-010 | API skeleton, auth, idempotency, pagination, OpenAPI | B | STRONG | — |
| T-014 | Store hardening: SQLite triggers, cached nodes, tables | B | STRONG | T-004 |
| T-015 | Uploads, content-addressed bundle store, receipt-gated delivery | B | STRONG | T-002, T-010 |
| T-024 | Organisation and signing-key registry | B | STRONG | T-010, T-014 |
| T-011 | LeRobot v3 dataset reader (read-only; episodes → file sets + ranges) | B | STRONG | T-015 |
| T-036 | Commit & append: manifests, leaves, append receipts, ingest job | B | STRONG | T-011, T-035, T-014, T-024 |
| T-012 | Proof and consent endpoints | B | CHEAP | T-036 |
| T-013 | Anchor scheduler daemon and lag alarm (revocation-only anchors) | B | CHEAP | T-007, T-014 |
| T-016 | Chain reads with cache (no indexer) | B | CHEAP | T-009, T-010 |
| T-018 | `timing.v1`, `kinematics.v1` | C | STRONG | T-036 |
| T-017 | `dedup.v1` (implementation; enablement gated by FD-1) | C | STRONG + G | T-036 |
| T-019 | `sensor_consistency.v1`, `sim_signature.v1` (indicative; FD-2) | C | STRONG + G | T-036 |
| T-020 | Claim issuance, signing, logging, `/claims`, checks config | C | STRONG | T-003, T-004, T-024, T-036 |
| T-021 | Badge engine and fixed wording | C | CHEAP | T-020, T-024 |
| T-025 | Provenance Report (JSON + PDF) | E | STRONG | T-006, T-012, T-016, T-021 |
| T-026 | `/verify` v2 | E | STRONG | T-005, T-009, T-021 |
| T-027 | Licence: seal + purchase scripts, minimal buyer page | E | STRONG | T-006, T-015, T-016 |
| T-029 | Site copy and chain-string audit | E | CHEAP | T-009, T-021 |
| T-030 | Adversarial suite | E | STRONG | Phase A, T-012, T-020 |
| T-032 | Slither, invariant tests, review pack | E | CHEAP | Phase A |
| T-033 | Golden demo + offline verifier CLI | E | STRONG | T-025, T-026, T-027 |
| T-037 | Devices and capture sessions | D | STRONG | T-024 |
| T-022 | Recorder SDK (Python) | D | STRONG | T-036, T-037, T-008 |
| T-023 | Attestation ingestion (FD-3) | D | STRONG + G | T-037 |
| T-034 | Shelve the foundry | F | CHEAP | — |
| T-031 | Observability and failure injection | F | CHEAP | T-010, T-013 |

Reports → `REPORTS.md`; conflicts and open frontier decisions → `CONFLICTS.md`.
