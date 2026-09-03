/**
 * T-036 — `POST /datasets/{id}/ingest`'s pipeline: materialise a dataset's
 * stored uploads into a scratch directory (T-011's `readDataset` reads a
 * directory, and the bundle store must never be modified in place — PLAN
 * §14/D-18), read its `EpisodeRef`s, and commit one episode per ref
 * through `commit.ts`.
 *
 * Split into two layers on purpose:
 *  - `commitEpisodesFromRefs` takes `EpisodeRef[]` directly and knows
 *    nothing about the filesystem or the bundle store — this is what
 *    `ingest.test.ts` calls to exercise partial-failure atomicity and
 *    salt-reuse refusal with synthetic refs, without needing real files.
 *  - `processIngest` is the full pipeline `routes/datasets.ts` calls:
 *    materialise → `readDataset` → `commitEpisodesFromRefs`.
 */
import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { keccak256, toHex, type Hex } from "viem";
import type { FileEntry } from "../../../../packages/protocol/src/payload.ts";
import { payloadHash } from "../../../../packages/protocol/src/payload.ts";
import { newConsentRecord, recordHash, consentCommitment, consentKey as deriveConsentKey } from "../../../../packages/protocol/src/consent.ts";
import { readDataset, type EpisodeRef } from "./lerobot.ts";
import type { BundleStore } from "../store/bundle.ts";
import type { DatasetRow } from "../../../log/src/store-interface.ts";
import { ApiError } from "../errors.ts";
import { commitEpisode, type CommitDeps, type CommitOutcome } from "./commit.ts";
import type { AppendReceipt } from "./receipt.ts";

export type EpisodeResult = {
  episode_index: number;
  leaf_hash: Hex;
  leaf_index: number;
  submitted_at: number;
  receipt: AppendReceipt;
  /** Returned to the org here and only here — never stored (PLAN §10.5). */
  salt: Hex;
};

export type EpisodeError = {
  episode_index: number;
  code: string;
  message: string;
};

export type IngestConsentInput = {
  holder: "contributor" | "organisation";
  pubkey: Hex;
  alg: "ed25519" | "p256";
  scope_bits: number;
};

export type IngestContext = {
  orgId: string;
  datasetId: string;
  source: "real" | "sim" | "mixed";
  termsHash: Hex;
  scopeBits: number;
  consent: IngestConsentInput;
  /** unix seconds — used as `captured_at` for every episode this ingest builds (PLAN §9.1: "a claim"; the reader has no per-episode capture timestamp). */
  capturedAt: number;
};

/** A fresh 32-byte salt (PLAN §10.5). Injectable so tests can force a collision deterministically. */
function freshSalt(): Hex {
  return toHex(randomBytes(32));
}

/**
 * PLAN §10.12-adjacent: builds the `CaptureManifest` (§9.1) for one
 * `EpisodeRef`. Returned as `unknown` on purpose — `commitEpisode` is the
 * single place that validates it, so a `null` `embodiment` (a dataset with
 * no `robot_type`) or a zero `rate_hz` (fps absent) surfaces as a normal
 * per-episode validation error rather than being patched over here with an
 * invented value (§5 I-11).
 */
export function buildManifestFromEpisode(ref: EpisodeRef, ctx: IngestContext, consentCommitmentHex: Hex): unknown {
  const files: FileEntry[] = ref.files.map((f) => ({ path: f.path, bytes: f.bytes, hash: f.hash }));
  return {
    v: 1,
    kind: "capture_manifest",
    org_id: ctx.orgId,
    dataset_id: ctx.datasetId,
    source: ctx.source,
    layout: ref.layout,
    embodiment: ref.embodiment,
    rate_hz: ref.rateHz,
    duration_ms: ref.durationMs,
    captured_at: ctx.capturedAt,
    channels: ref.channels,
    files,
    range: ref.range ? { episode_index: ref.episodeIndex, frames: ref.range.frames, video: ref.range.video } : null,
    payload_hash: payloadHash(files),
    consent_commitment: consentCommitmentHex,
    terms_hash: ctx.termsHash,
    scope_bits: ctx.scopeBits,
    task: ref.instruction ? { instruction: ref.instruction, task_id: null } : null,
    outcome: ref.success !== null ? { success: ref.success } : null,
    sim: null,
    signature: null,
  };
}

/**
 * Commits one episode per `EpisodeRef`: draws a fresh `ConsentRecord` and
 * salt, claims the salt (refusing a reuse — PLAN §10.5/§27 trap #9),
 * builds and validates the manifest, and appends through `commitEpisode`.
 * A failure on any one ref is caught and recorded in `errors`; the loop
 * continues (PLAN §12 binding rule: "jobs record per-episode errors and
 * continue").
 */
export async function commitEpisodesFromRefs(
  commitDeps: CommitDeps,
  refs: EpisodeRef[],
  ctx: IngestContext,
  saltFn: () => Hex = freshSalt,
): Promise<{ episodes: EpisodeResult[]; errors: EpisodeError[] }> {
  const episodes: EpisodeResult[] = [];
  const errors: EpisodeError[] = [];

  for (const ref of refs) {
    try {
      const salt = saltFn();
      const saltHash = keccak256(salt);
      if (!commitDeps.store.claimSalt(saltHash, ctx.orgId)) {
        throw new ApiError("conflict", `salt already used for org ${ctx.orgId} (episode ${ref.episodeIndex})`);
      }

      const record = newConsentRecord({
        holder: ctx.consent.holder,
        pubkey: ctx.consent.pubkey,
        alg: ctx.consent.alg,
        scope_bits: ctx.consent.scope_bits,
        terms_hash: ctx.termsHash,
        granted_at: commitDeps.now(),
      });
      const rHash = recordHash(record);
      const commitment = consentCommitment(rHash, salt);
      const cKey = deriveConsentKey(rHash);

      const manifest = buildManifestFromEpisode(ref, ctx, commitment);
      const outcome: CommitOutcome = await commitEpisode(commitDeps, ctx.orgId, manifest, ctx.datasetId, cKey);

      episodes.push({
        episode_index: ref.episodeIndex,
        leaf_hash: outcome.leafHash,
        leaf_index: outcome.leafIndex,
        submitted_at: outcome.submittedAt,
        receipt: outcome.receipt,
        salt,
      });
    } catch (err) {
      const code = err instanceof ApiError ? err.code : "internal";
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ episode_index: ref.episodeIndex, code, message });
    }
  }

  return { episodes, errors };
}

/**
 * Streams every stored upload named in `files` into `destDir` at its
 * manifest-relative path — a scratch copy `readDataset` can walk, built
 * without ever touching the bundle store's own objects (D-18: the server
 * never slices, re-encodes or otherwise mutates a supplier's files).
 */
export async function materializeDataset(bundleStore: BundleStore, files: FileEntry[], destDir: string): Promise<void> {
  for (const f of files) {
    const destPath = join(destDir, f.path);
    await mkdir(dirname(destPath), { recursive: true });
    const webStream = await bundleStore.open(f.hash as Hex);
    await pipeline(Readable.fromWeb(webStream as any), createWriteStream(destPath));
  }
}

/** The full `POST /datasets/{id}/ingest` pipeline. */
export async function processIngest(params: {
  commitDeps: CommitDeps;
  bundleStore: BundleStore;
  dataset: DatasetRow;
  body: {
    terms_hash: Hex;
    scope_bits: number;
    source: "real" | "sim" | "mixed";
    consent: IngestConsentInput;
  };
}): Promise<{ episodes: EpisodeResult[]; errors: EpisodeError[] }> {
  const files = JSON.parse(params.dataset.filesJson) as FileEntry[];
  const destDir = mkdtempSync(join(tmpdir(), "thenar-ingest-"));
  try {
    await materializeDataset(params.bundleStore, files, destDir);
    const { episodes: refs } = await readDataset(destDir);
    if (refs.length === 0) {
      throw new ApiError("unprocessable", `dataset ${params.dataset.datasetId} has 0 episodes`);
    }
    const ctx: IngestContext = {
      orgId: params.dataset.orgId,
      datasetId: params.dataset.datasetId,
      source: params.body.source,
      termsHash: params.body.terms_hash,
      scopeBits: params.body.scope_bits,
      consent: params.body.consent,
      capturedAt: params.commitDeps.now(),
    };
    return await commitEpisodesFromRefs(params.commitDeps, refs, ctx);
  } finally {
    await rm(destDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------
// In-process cache of full job results, salts included (PLAN §10.5 — the
// salt is "returned in the job result... never stored"). `routes/
// datasets.ts` populates one entry per completed ingest; `routes/jobs.ts`
// reads it for `GET /jobs/{id}`. Deliberately *not* part of the durable
// `job` row (`LogStore.createJob`/`updateJob`), which records status only.
// ---------------------------------------------------------------------

export type CachedJobResult = { orgId: string; episodes: EpisodeResult[]; errors: EpisodeError[] };

const jobResultCache = new Map<string, CachedJobResult>();

export function putCachedJobResult(jobId: string, result: CachedJobResult): void {
  jobResultCache.set(jobId, result);
}

export function getCachedJobResult(jobId: string): CachedJobResult | undefined {
  return jobResultCache.get(jobId);
}
