/**
 * Request bodies for §12 routes that are not themselves one of the §9
 * objects (a §9 object is used directly where the table names one, e.g.
 * `POST /episodes` takes `{ manifest, consent_key }` with `manifest`
 * validated against `CaptureManifest` and `consent_key` the caller's own
 * `keccak256(0x02 ‖ recordHash)` (D-37) — not part of `manifestHash`,
 * stored on the episode row so a later revocation resolves to it). All
 * closed (I-7).
 */
import { z } from "zod";
import { Hex32, HexBytes, Alg, FileEntry, Signature, strictObject } from "./common.ts";
import { CaptureManifest } from "./manifest.ts";
import { ConsentRecord } from "./consentRecord.ts";
import { SourceEnum } from "../../../../packages/protocol/src/schemas.ts";

export const CreateKeyBody = strictObject({
  alg: Alg,
  pubkey: HexBytes,
  attestation: z.unknown().optional(),
});

export const CreateUploadBody = strictObject({
  hash: Hex32,
  bytes: z.number().int().positive(),
});

export const CreateDatasetBody = strictObject({
  source_uri: z.string().optional(),
  info_json_hash: Hex32,
  files: z.array(FileEntry),
});

export const IngestDatasetBody = strictObject({
  terms_hash: Hex32,
  scope_bits: z.number().int().nonnegative(),
  source: SourceEnum,
  consent: strictObject({
    holder: z.enum(["contributor", "organisation"]),
    pubkey: HexBytes,
    alg: Alg,
    scope_bits: z.number().int().nonnegative(),
  }),
});

export const CreateEpisodeBody = strictObject({
  manifest: CaptureManifest,
  // D-37: the SDK path supplies `consent_key` alongside the manifest — the
  // server never sees the ConsentRecord or its salt, so it cannot derive
  // the SMT key itself. Not part of `manifestHash`; stored on the episode
  // row so a later revocation resolves to this episode.
  consent_key: Hex32,
});

export const RevokeConsentBody = strictObject({
  record: ConsentRecord,
  signature: Signature,
});
