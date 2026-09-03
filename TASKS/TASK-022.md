# T-022 — Recorder SDK (Python): sign at capture — Phase D, post-wedge

**Tier:** STRONG. Cross-language reimplementation held to `vectors.json`.

## Objective
`thenar-sdk` (Python ≥ 3.10): session key, per-episode CaptureManifest
(`layout: per_episode` — the recorder writes its own per-episode parquet and
MP4, so no ranges), `payloadHash` per §10.4, signature per §10.6, upload via
`POST /uploads`, submit via `POST /episodes`, keep append receipts; consent
record generation and revocation signing; a `lerobot` hook.

## Dependencies
T-036, T-037, T-008 (`vectors.json`).

## Files
- Create `sdk/python/thenar/{canonical,payload,manifest,sign,consent,client,lerobot_hook}.py`, `pyproject.toml`, `tests/` consuming `packages/protocol/test/fixtures/vectors.json`.
- Deps: `pynacl`, `cryptography` (P-256), `pycryptodome` (keccak), `requests`. JCS implemented locally and proven by vectors.

## Expected behaviour
Vector parity for JCS, payloadHash, manifestHash, consentKey, messages,
signatures; receipts persisted to `~/.thenar/receipts.jsonl`; retry with
the same `Idempotency-Key`; key backup instructions printed once.

## Tests
Parity; hook fires on a fake dataset; retry path.

## Acceptance
`pytest` green; fixture episode submits to a local API and appears in `/verify`.

## Security
Session key encrypted at rest (OS keyring when available); API key never logged.
