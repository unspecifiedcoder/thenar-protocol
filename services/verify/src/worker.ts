/**
 * T-020 — the verification worker: runs every enabled check (PLAN §10.9)
 * over a newly logged episode and issues one VerificationClaim leaf per
 * check via `issueClaim` (issue.ts).
 *
 * `runChecksForEpisode` rebuilds an `EpisodeRef` (T-011 shape) from the
 * episode's already-validated, already-stored manifest
 * (`store.episodeMeta(leafHash).manifest`), materialises its files out of
 * the bundle store into a scratch directory (`materializeDataset`, T-036's
 * `ingest/job.ts` — reused rather than re-implemented so there is exactly
 * one "walk a manifest's files out of the bundle store" routine), and runs
 * `timing.v1`/`kinematics.v1`/`sensor_consistency.v1`/`sim_signature.v1`
 * through `runOnEpisode` (T-018/T-019) plus `dedup.v1` (T-017) against the
 * shared `TrajectoryIndex`.
 *
 * "Check throws -> inconclusive with detail.error" (TASK-020.md Expected
 * behaviour): `runOnEpisode`'s own checks already return `inconclusive`
 * for bad per-episode data without throwing (T-018/T-019), so the only
 * throw surface here is materialising/reading the episode's files at all
 * (a missing upload, a corrupt parquet file). That is caught once; on
 * failure every enabled check for this episode gets a uniform
 * `inconclusive` claim carrying `detail.error` instead of being skipped
 * (a check that never runs would never register as `checks_run`, silently
 * weakening the badge engine's L3 rule — I-11).
 *
 * `enqueueEpisode`/`processPending` is the seam `Deps.onEpisodeCommitted`
 * (`services/api/src/ingest/commit.ts`) hooks into: the ingest path
 * doesn't import this module directly, it calls a callback the app wires
 * up, so a test can inject its own hook (or none) without pulling in
 * ffmpeg/parquet machinery.
 */
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hex } from "viem";
import type { ILogStore } from "../../log/src/store-interface.ts";
import type { BundleStore } from "../../api/src/store/bundle.ts";
import type { EpisodeRef } from "../../api/src/ingest/lerobot.ts";
import { readEpisodeFrames } from "../../api/src/ingest/lerobot.ts";
import { materializeDataset } from "../../api/src/ingest/job.ts";
import { runOnEpisode } from "./run.ts";
import { dedupCheck } from "./checks/dedup.ts";
import { CHECK_VERSION as TIMING_VERSION } from "./checks/timing.ts";
import { CHECK_VERSION as KINEMATICS_VERSION } from "./checks/kinematics.ts";
import { CHECK_VERSION as SENSOR_VERSION } from "./checks/sensor_consistency.ts";
import { CHECK_VERSION as SIM_VERSION } from "./checks/sim_signature.ts";
import { CHECK_VERSION as DEDUP_VERSION } from "./checks/dedup.ts";
import { TrajectoryIndex } from "./index/trajectory-index.ts";
import { getCheckConfig } from "./config.ts";
import { issueClaim, type VerifierSigner } from "./issue.ts";
import type { CheckOutcome } from "./types.ts";

export type WorkerDeps = {
  store: ILogStore;
  bundleStore: BundleStore;
  verifier: VerifierSigner;
  trajectoryIndex: TrajectoryIndex;
  now?: () => number;
};

/** Every check `runChecksForEpisode` may issue a claim for, and the `outcomes` key each maps to. */
const CHECKS: Array<{ name: string; version: string; outcomeKey: string }> = [
  { name: "timing.v1", version: TIMING_VERSION, outcomeKey: "timing" },
  { name: "kinematics.v1", version: KINEMATICS_VERSION, outcomeKey: "kinematics" },
  { name: "sensor_consistency.v1", version: SENSOR_VERSION, outcomeKey: "sensor_consistency" },
  { name: "sim_signature.v1", version: SIM_VERSION, outcomeKey: "sim_signature" },
  { name: "dedup.v1", version: DEDUP_VERSION, outcomeKey: "dedup" },
];

/** Rebuilds the T-011 `EpisodeRef` shape from a stored, already-validated CaptureManifest (§9.1). */
function buildEpisodeRef(m: any): EpisodeRef {
  return {
    episodeIndex: m.range?.episode_index ?? 0,
    layout: m.layout,
    files: m.files,
    range: m.range ?? null,
    frames: 0, // unused by readEpisodeFrames/runOnEpisode; only ref.range.frames matters
    rateHz: m.rate_hz,
    durationMs: m.duration_ms,
    instruction: m.task?.instruction ?? null,
    channels: m.channels,
    embodiment: m.embodiment ?? null,
    success: m.outcome?.success ?? null,
  };
}

/** Runs every enabled check over one already-logged episode and issues one claim each. */
export async function runChecksForEpisode(leafHash: Hex, deps: WorkerDeps): Promise<void> {
  const meta = deps.store.episodeMeta(leafHash);
  if (!meta || !meta.manifest) throw new Error(`no episode metadata for leaf ${leafHash}`);
  const m = JSON.parse(meta.manifest);
  const ref = buildEpisodeRef(m);
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));

  let outcomes: Record<string, CheckOutcome> | null = null;
  let error: string | null = null;
  const destDir = mkdtempSync(join(tmpdir(), "thenar-verify-"));
  try {
    await materializeDataset(deps.bundleStore, ref.files, destDir);
    const source = m.source === "sim" || m.source === "teleop_sim" ? "sim" : "real";
    const base = await runOnEpisode(ref, destDir, { source });

    const frames = await readEpisodeFrames(ref, destDir, ["timestamp", "observation.state"]);
    const state = frames["observation.state"] as unknown as number[][];
    const timestamp = Array.from(frames.timestamp as Float32Array | Float64Array | number[]);
    const dedup = dedupCheck(
      { state, timestamp },
      ref.embodiment ?? "",
      leafHash,
      deps.trajectoryIndex,
      getCheckConfig("dedup.v1"),
    );

    outcomes = { ...base, dedup };
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  } finally {
    await rm(destDir, { recursive: true, force: true });
  }

  for (const { name, version, outcomeKey } of CHECKS) {
    const config = getCheckConfig(name);
    if (!config.enabled) continue;

    const outcome: CheckOutcome = outcomes
      ? outcomes[outcomeKey]
      : {
          result: "inconclusive",
          level: 3,
          detail: { check_version: version, thresholds: config.thresholds ?? {}, error: error ?? "unknown error" },
        };

    await issueClaim(leafHash, name, outcome, deps.verifier, deps.store, { now, config });
  }
}

// --------------------------------------------------------------- pending queue

const pendingQueue: Hex[] = [];

/** Queues a leaf hash for `processPending` — the `Deps.onEpisodeCommitted` hook (`services/api/src/ingest/commit.ts`) calls this. */
export function enqueueEpisode(leafHash: Hex): void {
  pendingQueue.push(leafHash);
}

/**
 * Drains `leafHashes` (default: everything `enqueueEpisode` queued since
 * the last drain) through `runChecksForEpisode`. A failure on one episode
 * is not swallowed here — `runChecksForEpisode` already turns a per-episode
 * failure into `inconclusive` claims rather than throwing, so this only
 * throws on a `deps`-level problem (e.g. no verifier key configured).
 */
export async function processPending(deps: WorkerDeps, leafHashes?: Hex[]): Promise<void> {
  const queue = leafHashes ?? pendingQueue.splice(0, pendingQueue.length);
  for (const leafHash of queue) {
    await runChecksForEpisode(leafHash, deps);
  }
}
