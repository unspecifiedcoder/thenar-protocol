# T-010 — API skeleton, auth, idempotency, pagination, OpenAPI

**Tier:** STRONG.

## Objective
Stand up `services/api` (Hono on Node 22) exposing every PLAN §12 route as a
typed stub returning 501 `not_implemented` (except `/healthz`), with
API-key auth, `Idempotency-Key`, cursor pagination helpers, zod schemas for
every PLAN §9 object (closed schemas), structured errors, and generated
`openapi.json`.

## Dependencies
None (schemas may import from `packages/protocol` when T-035 lands; until
then define them here and T-035 replaces the import).

## Files
- Create `services/api/package.json`, `src/app.ts`, `src/auth.ts`, `src/errors.ts`, `src/idempotency.ts`, `src/pagination.ts`, `src/routes/*.ts`, `src/schemas/*.ts`, `test/api.test.ts`, `openapi.json`.
- Root `package.json`: `test:api`, `dev:api`; `packages/protocol/test/ci.ts` guard.
- Deps: `hono`, `@hono/node-server`, `zod`, `@hono/zod-openapi`.

## Expected behaviour
- Errors per PLAN §12 shape and code list; zod issues in `details`.
- Idempotency: same key + same body → stored response; different body → 409.
- Pagination helper: opaque base64 cursor over `(sort key, id)`; `limit` default 50, max 500.
- Auth: `Bearer` → `{orgId, role}` from an in-memory map (`API_KEYS_JSON`) until T-024; verifier role gate for `/claims`; wallet-signature header parsing for `/licences/*` (EIP-191 over `"THENAR download receipt <id> at <unixMinute>"`).
- Rate limit public POSTs at 60/min/IP.
- Schemas are closed (`.strict()`); any unknown key → 400 (this is the I-7 guard).

## Tests
Auth cases; idempotency replay/conflict; each schema with one valid and two
invalid fixtures (including a manifest with `chain_id`, and unsorted
`files[]`); `openapi.json` validates.

## Acceptance
`pnpm test:api` green; `pnpm dev:api` serves `/healthz`.

## Security
API keys hashed at rest; constant-time compare.
