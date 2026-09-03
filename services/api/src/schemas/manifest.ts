/**
 * PLAN §9.1 — CaptureManifest v1. The canonical definition now lives in
 * `packages/protocol/src/schemas.ts` (T-035) — this file re-exports it
 * under the name the rest of `services/api` already imports so routes and
 * `generate-openapi.ts` need no further changes.
 */
export { CaptureManifestSchema as CaptureManifest } from "../../../../packages/protocol/src/schemas.ts";
export type { CaptureManifest } from "../../../../packages/protocol/src/schemas.ts";
