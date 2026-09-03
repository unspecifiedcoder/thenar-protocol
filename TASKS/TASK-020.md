# T-020 — Claim issuance, signing, logging, `/claims`, checks config

**Tier:** STRONG (I-13, I-14, I-15, D-8).

## Objective
Worker that runs enabled checks per newly logged episode, signs
VerificationClaims, appends 0x04 leaves; `POST /claims` for registered
verifiers; `config/checks.json` loader.

## Dependencies
T-003, T-004, T-024, T-036.

## Files
- Create `services/verify/src/{worker,issue,config}.ts`, `services/api/src/routes/claims.ts`, `config/checks.json`, tests.

## Interfaces
```ts
export type CheckOutcome = { result: "pass"|"fail"|"inconclusive"; level: number; detail: JsonObject & { check_version: string; thresholds: JsonObject } };
export type CheckConfig = { enabled: boolean; blocking: boolean; emit_fail: boolean };
export async function issueClaim(subjectLeaf: Hex, check: CheckName, outcome: CheckOutcome, verifierKey): Promise<{ claim; leafHash; leafIndex }>;
```

## Expected behaviour
- Refuse to issue a claim whose `detail` lacks `check_version` or `thresholds` (I-15).
- If a check's config has `emit_fail: false`, a `fail` outcome is downgraded to `inconclusive` with `detail.downgraded_from: "fail"`.
- `detailHash = hashObject(detail)`; signature per §10.6 `claim`; leaf per §10.3.
- Idempotent per `(subjectLeaf, check, verifierKeyId, outcome)`; a changed outcome issues a new claim (append-only).
- `POST /claims`: verifier key resolved via T-024 with validity evaluated per D-20 (provisionally now; re-evaluated at anchor time by T-021); unknown check → 422.
- Check throws → `inconclusive` with `detail.error`.

## Tests
Round-trip; missing thresholds refused; downgrade path; external claim bad signature; idempotency.

## Acceptance
Golden demo step 2 produces claims for every episode.

## Security
Verifier key in env/KMS only; key id published on `/company` (T-029).
