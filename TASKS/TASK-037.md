# T-037 — Devices and capture sessions — Phase D

**Tier:** STRONG.

## Objective
`POST /devices`, `POST /sessions`, `POST /sessions/{id}/close`; manifests
may reference `session_id`/`device_id` (schema extension by ADR when this
task starts — file a conflict if §9.1 has not been amended).

## Dependencies
T-024.

## Expected behaviour
Device `level` defaults to 1; sessions bind a `sessionKeyId`; a manifest
referencing a closed session with `captured_at > endedAt` fails validation.

## Acceptance
Tests green; SDK (T-022) uses these endpoints.
