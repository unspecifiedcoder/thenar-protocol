/**
 * PLAN §9.6 — Report v1. Response-only shape (no route accepts a Report as
 * a request body); modelled here for completeness and for `openapi.json`.
 * Kept a shade looser than the request schemas — nested proof/consent
 * blobs are typed as unknown records rather than re-deriving Merkle proof
 * shapes that belong to `packages/protocol`.
 */
import { z } from "zod";
import { Hex32, UnixSeconds, strictObject } from "./common.ts";

const ChainAnchorRef = strictObject({
  chain_id: z.number().int().nonnegative(),
  index: z.number().int().nonnegative().optional(),
  block_number: z.number().int().nonnegative().optional(),
  at: UnixSeconds.optional(),
  tx: z.string().optional(),
});

const AnchorBlock = strictObject({
  root: Hex32,
  size: z.number().int().nonnegative(),
  revocation_root: Hex32.optional(),
  chains: z.array(ChainAnchorRef),
});

const Episode = z
  .object({
    leaf: Hex32,
    log_index: z.number().int().nonnegative(),
    corpus_index: z.number().int().nonnegative(),
    badges: z.array(z.string()),
    wording: z.array(z.string()),
    manifest_hash: Hex32,
    payload_hash: Hex32,
    preimage: z.string(),
    files: z.array(strictObject({ path: z.string(), hash: Hex32, bytes: z.number().int().nonnegative() })),
    range: z.unknown().nullable(),
    inclusion_proof_log: z.array(z.unknown()),
    inclusion_proof_corpus: z.array(z.unknown()),
    consent: z.unknown(),
    claims: z.array(z.unknown()),
    signature: z.unknown().optional(),
  })
  .strict();

export const Report = strictObject({
  v: z.literal(1),
  kind: z.literal("provenance_report"),
  report_id: z.string().min(1),
  generated_at: UnixSeconds,
  operator: strictObject({ name: z.string(), verifier_key_id: Hex32 }),
  corpus: z.unknown(),
  anchor: AnchorBlock,
  sealing_anchor: AnchorBlock,
  consistency_proof: z.array(z.unknown()),
  episodes: z.array(Episode),
  receipts: z.array(z.unknown()),
  checks_run: z.array(strictObject({ check: z.string(), check_version: z.string(), thresholds: z.record(z.string(), z.unknown()) })),
  limitations: z.array(z.string()),
  report_hash: Hex32,
});

export type Report = z.infer<typeof Report>;
