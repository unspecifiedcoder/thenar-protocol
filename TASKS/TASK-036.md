# T-036 — Commit & append: manifests, leaves, append receipts, ingest job

**Tier:** STRONG. The core wedge path.

## Objective
`POST /datasets`, `POST /datasets/{id}/ingest`, `GET /jobs/{id}`,
`POST /episodes`: build CaptureManifests from `EpisodeRef`s (T-011) or accept
one from the SDK, validate (T-035), recompute `payloadHash` from stored
uploads, build the 0x02 leaf via `manifestToEpisode`, append atomically, sign
an AppendReceipt.

## Dependencies
T-011, T-035, T-014, T-024, T-015.

## Files
- Create `services/api/src/ingest/{commit,job,receipt}.ts`, `src/routes/{datasets,episodes,jobs}.ts`, tests with the T-011 fixture.

## Expected behaviour
- Ingest builds, per episode: a fresh ConsentRecord (`holder` from request; pubkey = the org's designated consent key for W1), a 32-byte salt (returned to the org in the job result, **not stored**), the manifest per §9.1 with `files`/`channels` sorted, `layout`/`range` from the reader.
- `submittedAt` = server time at append; stored with the episode; returned in the receipt (§9.5) signed with the log service key (an org key with role `operator`).
- Duplicate `manifestHash` for the same org → 409 with the existing leaf.
- Failure anywhere before append → nothing written; job records the error per episode.
- `POST /episodes` (SDK path): manifest must carry a signature; files must already be `stored`.

## Edge cases
Dataset with 0 episodes → 422; a file referenced but not stored → 422 naming the hash; an episode whose `consent_commitment` reuses a prior salt → refuse (track salts hashed, not raw).

## Tests
Fixture → 3 leaves; recomputing `payloadHash` from the bundle store matches; receipts verify; duplicate refused; partial-failure atomicity.

## Acceptance
`pnpm test:api` green; golden demo step 1.

## Security
Receipts are the supplier's evidence against omission; the operator key is distinct from the verifier key.
