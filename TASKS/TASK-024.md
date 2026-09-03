# T-024 — Organisation and signing-key registry

**Tier:** STRONG. Time-bounded key validity used by every signature check
(D-20).

## Objective
`POST /orgs/{id}/keys`, `GET /orgs/{id}/keys`, `POST /orgs/{id}/keys/{keyId}/revoke`;
`resolveKey(keyId, at)`; admin CLI to create orgs, API keys and verifier keys.

## Dependencies
T-010, T-014.

## Files
- Create `services/api/src/routes/orgs.ts`, `src/registry.ts`, `bin/thenar-admin.ts`, tests.

## Expected behaviour
- Keys append-only with `validFrom = now`; revoke sets `validTo = now` once.
- `resolveKey(keyId, at)` returns the key iff `validFrom ≤ at < validTo`.
- `attestation` field accepted but stored as `level: 1` until T-023 exists (never 2).
- Public listing omits attestation blobs.
- Roles: `supplier`, `buyer`, `verifier` per key; `/claims` requires `verifier`.

## Edge cases
Same pubkey twice → 409; revoking an already-revoked key → 409.

## Tests
Validity windows; discovery; CLI flows.

## Acceptance
T-020, T-021, T-036 resolve keys here.

## Security
Admin CLI local-only with `ADMIN_TOKEN`.
