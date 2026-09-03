# T-038 — Lab arm recorder: browser arm → signed `sim` manifests — Phase D (D-31, D-34 gate)

**Tier:** STRONG. **Do not start before E2 (three paid reports).**

## Objective
Port the live site's THENAR-6 browser arm (IK-driven, no physics) into
`apps/web/lab/arm/` as a *reference capture source of kind `sim`*: an
operator drives the arm, the recorder writes a per-episode parquet
(`observation.state`, `action`, `timestamp` at a fixed rate) in the browser,
builds a CaptureManifest (`source: "sim"`, `layout: "per_episode"`,
`holder: "organisation"`), signs it with a WebAuthn passkey (P-256, D-26),
uploads via `POST /uploads` and submits via `POST /episodes`.

## Context
The live Axon codebase is not in this repository; the GLB arm and IK solver
must be brought in under their original licence with attribution. No escrow,
no reward, no leaderboard — the page states "Lab — simulated; declared
source: simulation; never physical".

## Dependencies
T-036, T-040, T-024 (passkey registered as an org key with `alg: p256`).

## Files
`apps/web/lab/arm/{index.html,arm.js,recorder.js,parquet.js}` (a minimal parquet writer or JSONL if a browser writer is unavailable — if JSONL, the manifest `channels[].dtype` must say so and T-011 must read it; file a conflict if that needs a schema change), `apps/web/test/lab-arm.test.mjs`.

## Expected behaviour
Episode files hash per §10.4 in the browser; manifest validates against
`CaptureManifestSchema`; the passkey signature verifies server-side; the
episode appears on `/verify` with badges L0/L1 (after anchoring) and
`source: declared simulation`.

## Tests
jsdom: recorder produces deterministic files for a scripted trajectory;
manifest validates; signature message bytes equal `vectors.json`.

## Acceptance
Golden-demo extension: step 1 via the lab arm.

## Security
The passkey proves the operator's device signed; the page must never imply a robot moved.
