/**
 * PLAN §9 — the canonical zod schemas for every JSON object THENAR hashes:
 * CaptureManifest (§9.1), CorpusManifest (§9.2), VerificationClaim (§9.3),
 * ConsentRecord (§9.4), AppendReceipt (§9.5).
 *
 * Every schema here is `.strict()` (closed): an unknown key — `chain_id`
 * above all — is rejected rather than dropped. That is I-7's guard against
 * chain-specific data leaking into a leaf or manifest (§27 trap #19).
 * Set-like arrays (`channels[]`, `files[]`) are validated sorted and unique
 * per D-28 (§27 trap #1/#2 guard).
 *
 * `services/api/src/schemas/*.ts` re-exports these rather than redefining
 * them — this file is the single source of truth for what a THENAR JSON
 * object may contain.
 */
import { z } from "zod";
import { assertPath, payloadHash as computePayloadHash, type FileEntry as PayloadFileEntry } from "./payload";
import type { Hex } from "viem";

// ---------------------------------------------------------------- primitives

const Hex32 = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/, "must be 0x + 64 lowercase hex chars");

const HexBytes = z
  .string()
  .regex(/^0x[0-9a-f]*$/, "must be 0x-prefixed lowercase hex");

const UnixSeconds = z.number().int().nonnegative();

const Alg = z.enum(["ed25519", "p256", "secp256k1"]);

/**
 * §1.1/D-30 — the source axis. Additive since v2.2: `"real"` is rejected
 * (the enum's own error message names the new values). `sim`/`teleop_sim`
 * can never become "attested"; only `teleop_real`/`autonomous_real` can.
 */
export const SourceEnum = z.enum(["sim", "teleop_sim", "teleop_real", "autonomous_real", "mixed"]);
export type Source = z.infer<typeof SourceEnum>;

const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

/** Compare two strings by their UTF-8 byte sequence, not UTF-16 code units (§27 trap #2). */
function utf8Compare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/** D-28: set-like arrays are sorted by the stated key and reject unsorted or duplicate entries. */
function sortedUniqueBy<T>(
  items: T[],
  key: (item: T) => string,
  cmp: (a: string, b: string) => number,
): { ok: true } | { ok: false; reason: string } {
  for (let i = 1; i < items.length; i++) {
    const prev = key(items[i - 1]);
    const cur = key(items[i]);
    const c = cmp(prev, cur);
    if (c === 0) return { ok: false, reason: `duplicate entry at index ${i}` };
    if (c > 0) return { ok: false, reason: `entries not sorted at index ${i}` };
  }
  return { ok: true };
}

/** §9.1 path rule, delegated to `assertPath` so there is exactly one implementation. */
function isValidManifestPath(path: string): boolean {
  try {
    assertPath(path);
    return true;
  } catch {
    return false;
  }
}

const FileEntrySchema = strictObject({
  path: z.string().refine(isValidManifestPath, "invalid manifest path"),
  bytes: z.number().int().nonnegative(),
  hash: Hex32,
});

const Signature = strictObject({
  alg: Alg,
  key_id: Hex32,
  sig: HexBytes,
});

const UINT64_MAX = (1n << 64n) - 1n;

/** decimal string fitting a uint64 (PLAN §9.1 `sim.world_seed`). */
function isUint64Decimal(s: string): boolean {
  if (!/^[0-9]+$/.test(s)) return false;
  try {
    const n = BigInt(s);
    return n >= 0n && n <= UINT64_MAX;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------- 9.1 CaptureManifest

const Channel = strictObject({
  name: z.string().min(1),
  dtype: z.string().min(1),
  shape: z.array(z.number().int().nonnegative()),
  hz: z.number().positive().optional(),
  unit: z.string().optional(),
});

const RangeVideo = z.record(z.string(), z.tuple([z.number(), z.number()]));

const RangeSchema = strictObject({
  episode_index: z.number().int().nonnegative(),
  frames: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  video: RangeVideo.optional(),
});

export const CaptureManifestSchema = strictObject({
  v: z.literal(1),
  kind: z.literal("capture_manifest"),
  org_id: z.string().min(1),
  dataset_id: z.string().min(1).nullable(),
  source: SourceEnum,
  layout: z.enum(["chunked", "per_episode"]),
  embodiment: z.string().min(1),
  rate_hz: z.number().positive(),
  duration_ms: z.number().int().nonnegative(),
  captured_at: UnixSeconds,
  channels: z.array(Channel),
  files: z.array(FileEntrySchema),
  range: RangeSchema.nullable(),
  payload_hash: Hex32,
  consent_commitment: Hex32,
  terms_hash: Hex32,
  scope_bits: z.number().int().nonnegative(),
  task: strictObject({
    instruction: z.string(),
    task_id: Hex32.nullable(),
  }).nullable(),
  outcome: strictObject({ success: z.boolean() }).nullable(),
  sim: strictObject({
    task_spec_hash: Hex32,
    world_seed: z.string().refine(isUint64Decimal, "world_seed must be a decimal string fitting uint64"),
  }).nullable(),
  signature: Signature.nullable(),
}).superRefine((m, ctx) => {
  const channelsSorted = sortedUniqueBy(m.channels, (c) => c.name, utf8Compare);
  if (!channelsSorted.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["channels"],
      message: `channels[] must be sorted by name and unique: ${channelsSorted.reason}`,
    });
  }
  const filesSorted = sortedUniqueBy(m.files, (f) => f.path, utf8Compare);
  if (!filesSorted.ok) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["files"],
      message: `files[] must be sorted by path and unique: ${filesSorted.reason}`,
    });
  }
  if (m.layout === "chunked" && m.range === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["range"],
      message: 'range is required when layout is "chunked"',
    });
  }
});

export type CaptureManifest = z.infer<typeof CaptureManifestSchema>;

// ----------------------------------------------------------- 9.2 CorpusManifest

export const CorpusManifestSchema = strictObject({
  v: z.literal(1),
  kind: z.literal("corpus_manifest"),
  org_id: z.string().min(1),
  title: z.string().min(1),
  episodes: z.array(Hex32),
  corpus_root: Hex32.optional(),
  episode_count: z.number().int().nonnegative().optional(),
  terms_hash: Hex32,
  task_id: Hex32.nullable(),
  // §9.2/D-30: SORTED, unique, derived by the server from member episodes.
  // Optional here for the same reason `corpus_root`/`episode_count` are:
  // it is server-computed, so `CorpusManifestInput` (services/api) omits it
  // from the caller-supplied body.
  sources: z.array(SourceEnum).optional(),
  filters: strictObject({
    min_badges: z.array(z.string()),
    exclude_failed_checks: z.boolean(),
  }).partial().strict(),
  sealed_at: UnixSeconds.nullable().optional(),
}).superRefine((m, ctx) => {
  const seen = new Set<string>();
  for (const [i, e] of m.episodes.entries()) {
    if (seen.has(e)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["episodes", i], message: "episodes[] must be unique" });
    }
    seen.add(e);
  }
  if (m.sources) {
    const sourcesSorted = sortedUniqueBy(m.sources, (s) => s, utf8Compare);
    if (!sourcesSorted.ok) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sources"],
        message: `sources[] must be sorted (bytewise) and unique: ${sourcesSorted.reason}`,
      });
    }
  }
});

export type CorpusManifest = z.infer<typeof CorpusManifestSchema>;

// -------------------------------------------------------- 9.3 VerificationClaim

const CheckName = z.enum([
  "dedup.v1",
  "timing.v1",
  "kinematics.v1",
  "sensor_consistency.v1",
  "sim_signature.v1",
  "attestation.v1",
]);

/** `detail.thresholds` is required (I-15, §27 trap #12). */
const Detail = z
  .object({
    check_version: z.string().min(1),
    thresholds: z.record(z.string(), z.unknown()),
    index_snapshot: z.string().optional(),
  })
  .catchall(z.unknown());

export const VerificationClaimSchema = strictObject({
  v: z.literal(1),
  kind: z.literal("verification_claim"),
  subject_leaf: Hex32,
  verifier_key_id: Hex32,
  check: CheckName,
  result: z.enum(["pass", "fail", "inconclusive"]),
  level_asserted: z.number().int().min(0).max(4),
  detail: Detail,
  issued_at: UnixSeconds,
  signature: Signature,
});

export type VerificationClaim = z.infer<typeof VerificationClaimSchema>;

// ----------------------------------------------------------- 9.4 ConsentRecord

export const ConsentRecordSchema = strictObject({
  v: z.literal(1),
  kind: z.literal("consent_record"),
  holder: z.enum(["contributor", "organisation"]),
  pubkey: HexBytes,
  alg: Alg,
  scope_bits: z.number().int().nonnegative(),
  terms_hash: Hex32,
  granted_at: UnixSeconds,
  nonce: z.string().regex(/^0x[0-9a-f]{32}$/, "nonce must be 0x + 16 bytes of lowercase hex"),
});

export type ConsentRecord = z.infer<typeof ConsentRecordSchema>;

// ----------------------------------------------------------- 9.5 AppendReceipt

export const AppendReceiptSchema = strictObject({
  v: z.literal(1),
  kind: z.literal("append_receipt"),
  leaf_hash: Hex32,
  leaf_index: z.number().int().nonnegative(),
  log_size_after: z.number().int().nonnegative(),
  received_at: UnixSeconds,
  signature: Signature,
});

export type AppendReceipt = z.infer<typeof AppendReceiptSchema>;

// --------------------------------------------------------------- validation

export type Issue = { path: (string | number)[]; message: string };

/**
 * Structural validation via `CaptureManifestSchema`, plus the one check a
 * zod schema cannot express: `payload_hash` must equal `payloadHash(files)`
 * (PLAN §10.4) recomputed from the manifest's own `files[]`. A manifest
 * whose `payload_hash` was hand-edited (or drifted from its files) is
 * rejected here rather than trusted.
 */
export function validateManifest(
  m: unknown,
): { ok: true; value: CaptureManifest } | { ok: false; issues: Issue[] } {
  const parsed = CaptureManifestSchema.safeParse(m);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => ({ path: i.path, message: i.message })) };
  }
  const value = parsed.data;
  let recomputed: Hex;
  try {
    recomputed = computePayloadHash(value.files as PayloadFileEntry[]);
  } catch (e) {
    return {
      ok: false,
      issues: [{ path: ["files"], message: e instanceof Error ? e.message : String(e) }],
    };
  }
  if (recomputed !== value.payload_hash) {
    return {
      ok: false,
      issues: [
        {
          path: ["payload_hash"],
          message: `payload_hash ${value.payload_hash} does not match recomputed ${recomputed}`,
        },
      ],
    };
  }
  return { ok: true, value };
}
