# T-040 — Source axis: schema enum, corpus `sources[]`, declared/attested wording

**Tier:** STRONG (schema + wording on the I-1/I-16 path; fully specified by D-30).

## Objective
Implement D-30: extend `CaptureManifest.source` to
`sim | teleop_sim | teleop_real | autonomous_real | mixed` (additive —
existing `real` is **rejected** from now on; `sim`/`mixed` unchanged), add
`sources[]` to CorpusManifest, and add the source line to badges/wording.

## Dependencies
T-035 (schemas), T-021 (badges), T-019 (`sim_signature.v1` result feeds the attested condition).

## Files
- Modify `packages/protocol/src/schemas.ts` (enum; CorpusManifest `sources: string[]` sorted, unique, derived by the server from member episodes), `packages/protocol/src/wording.ts` (add), `packages/protocol/src/badges.ts` (add `source` block), tests `packages/protocol/test/{schemas,badges}.ts`, `services/api/src/routes/corpora.ts` (derive `sources[]` when logging a corpus), `apps/web/wording.js` (mirror), `services/api/test/ingest.test.ts` (fixture manifests use `sim` or `teleop_real`).
- `PLAN.md §9.1/§9.2` already updated by v2.2; do not edit PLAN.

## Wording (verbatim; D-30)
- Declared: `Source — declared by the signer: {simulation | human-driven simulation | human-driven physical robot | autonomous physical robot | mixed}. Not attested.`
- Attested (only `teleop_real`/`autonomous_real`, only when the D-30 condition holds): `Source — attested physical capture: controller key attested by {manufacturer} ({model}); simulation-signature check passed.`
- Corpus: `Sources — {list}; {n} of {m} episodes declared physical, {k} attested.`

## Rules
```
attestedPhysical = source ∈ {teleop_real, autonomous_real}
                && attestation?.level == 2 && attestation.subject == "robot_controller"
                && latest(sim_signature.v1) == "pass"
                && (no video channel || latest(sensor_consistency.v1) == "pass")
```
`attestation.subject` is a new field on SigningKey attestation records
(`"signer_device" | "robot_controller"`), default `"signer_device"`; only
`robot_controller` can satisfy the condition (a phone's secure element
attests the signer, not the robot).

## Tests
Enum rejections (`real` rejected with a message naming the new values);
`sources[]` derivation and sorting; badges truth table rows for each source
× attestation subject × sim_signature result; wording snapshot; grep guard
extended with "physical" appearing without "declared" or "attested" on any
page.

## Acceptance
`pnpm test:protocol`, `pnpm test:api`, `pnpm test:web` green; T-026 renders
the source line.

## Security
This task is the guard against the most damaging over-claim; do not loosen.
