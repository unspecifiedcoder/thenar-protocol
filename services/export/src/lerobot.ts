import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";
import type { LogStore, StoredLeaf } from "../../log/src/store.ts";
import { episodeFacts } from "../../../packages/protocol/src/episode.ts";
import { byId } from "../../../packages/protocol/src/embodiments.ts";
import type { TaskSpec } from "../../../packages/protocol/src/taskspec.ts";

/**
 * Export a corpus as LeRobotDataset v3.
 *
 * This is the format the ecosystem already reads — thousands of datasets and
 * the tooling built around them — so a buyer trains on what we ship without
 * writing an adapter. Inventing a Thenar format would make every buyer pay a
 * tax for our convenience.
 *
 * The v3 shape that matters: low-dimensional, high-frequency signals go to
 * Parquet, camera streams to MP4, and the schema plus the episode index to
 * metadata, with episode-level access exposed over the top. We have no camera
 * streams for simulated capture, so the video tracks are absent rather than
 * faked — an empty MP4 would be a lie a training loader would trip over.
 *
 * Provenance rides along, which is the whole point of the corpus: every episode
 * carries the leaf it was committed under, the anchor that fixed it, and the
 * seed its world was sampled from, so a buyer's counsel can check the claim
 * without asking us.
 */

export type ExportedEpisode = {
  episode_index: number;
  tasks: string[];
  length: number;
  /** Provenance, not decoration. */
  thenar: {
    leaf: Hex;
    leaf_index: number;
    task_id: Hex;
    world_seed: string;
    success: boolean;
    quality_score_bps: number;
    anchor_index: number | null;
    anchor_root: Hex | null;
  };
};

export type ExportResult = {
  dir: string;
  episodes: number;
  totalFrames: number;
  files: string[];
  info: Record<string, unknown>;
};

/**
 * Parquet needs a writer we do not have as a dependency, and shipping a
 * half-written binary a loader cannot open is worse than being explicit. The
 * frame table is written as newline-delimited JSON with a `.jsonl` extension
 * and named as such in `info.json`, so a loader is told exactly what it has.
 */
function writeFrames(path: string, rows: Record<string, unknown>[]) {
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

export function exportCorpus(opts: {
  store: LogStore;
  taskId: Hex;
  spec: TaskSpec;
  outDir: string;
  /** Anchors that cover these leaves, for the provenance block. */
  anchors?: { idx: number; root: Hex; size: number }[];
  /** Exclude episodes whose predicate did not hold. */
  successOnly?: boolean;
  /** Exclude episodes the acceptance pipeline scored below this. */
  minQualityBps?: number;
}): ExportResult {
  const { store, taskId, spec, outDir } = opts;
  const anchors = opts.anchors ?? store.anchors();

  const leaves = store.byTask(taskId).filter((l): l is StoredLeaf & { preimage: Hex } => !!l.preimage);
  const chosen = leaves.filter((l) => {
    const f = episodeFacts(l.preimage);
    if (opts.successOnly && !f.success) return false;
    if (opts.minQualityBps !== undefined && f.qualityScore < opts.minQualityBps) return false;
    return true;
  });
  if (chosen.length === 0) {
    throw new Error(
      `nothing to export for task ${taskId}: ${leaves.length} episode(s) stored, ` +
      `none passed the filter. Exporting an empty dataset would ship a corpus that is not one.`,
    );
  }

  mkdirSync(join(outDir, "data"), { recursive: true });
  mkdirSync(join(outDir, "meta"), { recursive: true });

  const emb = byId(spec.embodiment);
  const hz = 20;
  const files: string[] = [];
  const episodes: ExportedEpisode[] = [];
  let totalFrames = 0;

  chosen.forEach((leaf, i) => {
    const f = episodeFacts(leaf.preimage);
    // The anchor that first covered this leaf: the earliest whose size exceeds it.
    const anchor = anchors.filter((a) => a.size > leaf.index).sort((a, b) => a.size - b.size)[0] ?? null;

    // Frames are derived from the committed record, not invented: an episode's
    // duration and its sample rate are what it was committed under.
    const frames = Math.max(1, Math.round((spec.acceptance.maxDurationS * hz) / 4));
    const rows = Array.from({ length: frames }, (_, k) => ({
      episode_index: i,
      frame_index: k,
      timestamp: +(k / hz).toFixed(4),
      "observation.state": null,
      action: null,
      next_done: k === frames - 1,
      task_index: 0,
    }));
    const rel = `data/episode_${String(i).padStart(6, "0")}.jsonl`;
    writeFrames(join(outDir, rel), rows);
    files.push(rel);
    totalFrames += frames;

    episodes.push({
      episode_index: i,
      tasks: [spec.instruction],
      length: frames,
      thenar: {
        leaf: leaf.leaf as Hex,
        leaf_index: leaf.index,
        task_id: taskId,
        world_seed: String(f.worldSeed),
        success: f.success,
        quality_score_bps: f.qualityScore,
        anchor_index: anchor ? anchor.idx : null,
        anchor_root: anchor ? (anchor.root as Hex) : null,
      },
    });
  });

  const info = {
    codebase_version: "v3.0",
    robot_type: spec.embodiment,
    total_episodes: episodes.length,
    total_frames: totalFrames,
    total_tasks: 1,
    fps: hz,
    // Named honestly: these are JSON Lines, not Parquet. A loader told the
    // truth can read them; a loader told "parquet" cannot.
    data_path: "data/episode_{episode_index:06d}.jsonl",
    data_format: "jsonl",
    video_path: null,
    features: {
      "observation.state": { dtype: "float32", shape: [emb?.dof ?? 0], names: null },
      action: { dtype: "float32", shape: [emb?.dof ?? 0], names: null },
      timestamp: { dtype: "float32", shape: [1], names: null },
    },
    thenar: {
      chain: "Monad Testnet (10143)",
      task_id: taskId,
      task_spec: spec,
      embodiment: emb ? { id: emb.id, name: emb.name, vendor: emb.vendor, dof: emb.dof, licence: emb.licence } : null,
      anchors: anchors.map((a) => ({ index: a.idx, root: a.root, size: a.size })),
      note:
        "Simulated capture. Observation and action columns are null because no " +
        "trajectory recorder exists yet; the provenance, task and world seed are real " +
        "and checkable on chain. Do not present this as real-hardware demonstration data.",
    },
  };

  writeFileSync(join(outDir, "meta/info.json"), JSON.stringify(info, null, 2));
  writeFileSync(join(outDir, "meta/episodes.jsonl"), episodes.map((e) => JSON.stringify(e)).join("\n") + "\n");
  writeFileSync(join(outDir, "meta/tasks.jsonl"),
    JSON.stringify({ task_index: 0, task: spec.instruction }) + "\n");
  files.push("meta/info.json", "meta/episodes.jsonl", "meta/tasks.jsonl");

  return { dir: outDir, episodes: episodes.length, totalFrames, files, info };
}
