#!/usr/bin/env node
// --experimental-strip-types
/**
 * `scripts/lib/jitter-fixture.mjs` — T-033, PLAN §21 step 1.
 *
 * Builds a small, real LeRobot v3 "chunked" dataset directory holding a
 * single episode: episode index 1 ("episode 2", 0-indexed) of the T-011
 * fixture (`services/api/test/fixtures/lerobot-v3`), read back with
 * `hyparquet` and re-written with `hyparquet-writer` after adding
 * per-frame, per-joint Gaussian noise (mean 0, std 1 degree in radians) to
 * `observation.state` — the same jitter shape PLAN §21 step 1 and
 * `services/verify/test/dedup.test.ts`'s own `jitter()` helper use, so
 * `dedup.v1` treats it as a near neighbour of the real episode 2 once both
 * are ingested into the same running server (shared `TrajectoryIndex`).
 *
 * Schema and file layout mirror `scripts/fixtures/make-lerobot-fixture.ts`
 * exactly (same parquet schema fragments, same `meta/info.json` shape) —
 * `services/api/src/ingest/lerobot.ts` reads this as a completely ordinary
 * one-episode v3 dataset. `action`/`timestamp`/`next.success` are copied
 * unmodified from the source episode; only `observation.state` is jittered
 * (D-18: this never touches the *original* fixture files — it reads them
 * once and writes an entirely new directory).
 */
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
// @ts-ignore -- hyparquet/hyparquet-writer ship JS + .d.ts; tsx/node resolve the ESM entry at runtime
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";
// @ts-ignore
import { parquetWriteFile } from "hyparquet-writer";

const FPS = 30;
const CAMERA = "observation.images.front";
const DEG = Math.PI / 180;

function writeParquet(path, options) {
  mkdirSync(dirname(path), { recursive: true });
  parquetWriteFile({ filename: path, ...options });
}

function writeJson(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

function listFloatSchema(name) {
  return [
    { name, repetition_type: "OPTIONAL", converted_type: "LIST", num_children: 1 },
    { name: "list", repetition_type: "REPEATED", num_children: 1 },
    { name: "element", type: "FLOAT", repetition_type: "REQUIRED" },
  ];
}
function listStringSchema(name) {
  return [
    { name, repetition_type: "OPTIONAL", converted_type: "LIST", num_children: 1 },
    { name: "list", repetition_type: "REPEATED", num_children: 1 },
    { name: "element", type: "BYTE_ARRAY", converted_type: "UTF8", repetition_type: "REQUIRED" },
  ];
}

/** Box-Muller standard normal, driven by a seeded LCG so a given seed reproduces the same jitter. */
function makeRand(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}
function gaussian(rand) {
  let u = 0, v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Reads episode index `sourceEpisodeIndex` out of `sourceFixtureDir` (a
 * v3 "chunked" LeRobot dataset with a single data chunk, one video chunk)
 * and writes a fresh one-episode v3 dataset to `destDir` with
 * `observation.state` jittered by N(0, 1°) per joint per frame. Returns
 * `{ episodeIndex: 0, sourceEpisodeIndex, frames }`.
 */
export async function buildJitterFixture(sourceFixtureDir, destDir, { seed = 20260903, sigmaDeg = 1 } = {}) {
  const info = JSON.parse(readFileSync(join(sourceFixtureDir, "meta", "info.json"), "utf8"));
  const dataFile = await asyncBufferFromFile(join(sourceFixtureDir, "data", "chunk-000", "file-000.parquet"));
  const allRows = await parquetReadObjects({ file: dataFile });

  const sourceEpisodeIndex = 1; // "episode 2" — the second episode, 0-indexed, per PLAN §21 step 1.
  const rows = allRows
    .filter((r) => Number(r.episode_index) === sourceEpisodeIndex)
    .sort((a, b) => Number(a.frame_index) - Number(b.frame_index));
  if (rows.length === 0) {
    throw new Error(`jitter-fixture: source fixture has no rows for episode_index=${sourceEpisodeIndex}`);
  }

  const tasksFile = await asyncBufferFromFile(join(sourceFixtureDir, "meta", "tasks.parquet"));
  const taskRows = await parquetReadObjects({ file: tasksFile });
  const taskIndex0 = Number(rows[0].task_index);
  const taskRow = taskRows.find((t) => Number(t.task_index) === taskIndex0);
  const task = taskRow ? String(taskRow.task) : "unknown task";

  const rand = makeRand(seed);
  const frames = rows.length;

  const episodeIndexCol = [];
  const frameIndexCol = [];
  const indexCol = [];
  const timestampCol = [];
  const taskIndexCol = [];
  const stateCol = [];
  const actionCol = [];
  const successCol = [];

  rows.forEach((r, f) => {
    episodeIndexCol.push(0);
    frameIndexCol.push(f);
    indexCol.push(f);
    timestampCol.push(Number(r.timestamp));
    taskIndexCol.push(0);
    const jittered = (r["observation.state"] ?? []).map((v) => Number(v) + gaussian(rand) * sigmaDeg * DEG);
    stateCol.push(jittered);
    actionCol.push((r.action ?? []).map((v) => Number(v)));
    successCol.push(Boolean(r["next.success"]));
  });

  const dataSchema = [
    { name: "root", num_children: 8 },
    { name: "episode_index", type: "INT32", repetition_type: "REQUIRED" },
    { name: "frame_index", type: "INT32", repetition_type: "REQUIRED" },
    { name: "index", type: "INT32", repetition_type: "REQUIRED" },
    { name: "timestamp", type: "DOUBLE", repetition_type: "REQUIRED" },
    { name: "task_index", type: "INT32", repetition_type: "REQUIRED" },
    ...listFloatSchema("observation.state"),
    ...listFloatSchema("action"),
    { name: "next.success", type: "BOOLEAN", repetition_type: "REQUIRED" },
  ];
  writeParquet(join(destDir, "data", "chunk-000", "file-000.parquet"), {
    schema: dataSchema,
    columnData: [
      { name: "episode_index", data: episodeIndexCol },
      { name: "frame_index", data: frameIndexCol },
      { name: "index", data: indexCol },
      { name: "timestamp", data: timestampCol },
      { name: "task_index", data: taskIndexCol },
      { name: "observation.state", data: stateCol },
      { name: "action", data: actionCol },
      { name: "next.success", data: successCol },
    ],
  });

  // A minimal, deterministic video blob (`thenar_fixture: true`, same
  // convention as `make-lerobot-fixture.ts` when ffmpeg is unavailable) —
  // this script never decodes video (D-18) and the reader only refs/hashes
  // the container file.
  const videoPath = join(destDir, "videos", CAMERA, "chunk-000", "file-000.mp4");
  mkdirSync(dirname(videoPath), { recursive: true });
  const blob = Buffer.alloc(1024);
  const tag = "thenar-jitter-fixture";
  for (let i = 0; i < blob.length; i++) blob[i] = (tag.charCodeAt(i % tag.length) + i * 11) & 0xff;
  writeFileSync(videoPath, blob);

  const episodesSchema = [
    { name: "root", num_children: 11 },
    { name: "episode_index", type: "INT32", repetition_type: "REQUIRED" },
    { name: "length", type: "INT32", repetition_type: "REQUIRED" },
    { name: "dataset_from_index", type: "INT32", repetition_type: "REQUIRED" },
    { name: "dataset_to_index", type: "INT32", repetition_type: "REQUIRED" },
    { name: "data/chunk_index", type: "INT32", repetition_type: "REQUIRED" },
    { name: "data/file_index", type: "INT32", repetition_type: "REQUIRED" },
    { name: `videos/${CAMERA}/chunk_index`, type: "INT32", repetition_type: "REQUIRED" },
    { name: `videos/${CAMERA}/file_index`, type: "INT32", repetition_type: "REQUIRED" },
    { name: `videos/${CAMERA}/from_timestamp`, type: "DOUBLE", repetition_type: "REQUIRED" },
    { name: `videos/${CAMERA}/to_timestamp`, type: "DOUBLE", repetition_type: "REQUIRED" },
    ...listStringSchema("tasks"),
  ];
  writeParquet(join(destDir, "meta", "episodes", "chunk-000", "file-000.parquet"), {
    schema: episodesSchema,
    columnData: [
      { name: "episode_index", data: [0] },
      { name: "length", data: [frames] },
      { name: "dataset_from_index", data: [0] },
      { name: "dataset_to_index", data: [frames] },
      { name: "data/chunk_index", data: [0] },
      { name: "data/file_index", data: [0] },
      { name: `videos/${CAMERA}/chunk_index`, data: [0] },
      { name: `videos/${CAMERA}/file_index`, data: [0] },
      { name: `videos/${CAMERA}/from_timestamp`, data: [0] },
      { name: `videos/${CAMERA}/to_timestamp`, data: [frames / FPS] },
      { name: "tasks", data: [[task]] },
    ],
  });

  writeParquet(join(destDir, "meta", "tasks.parquet"), {
    columnData: [
      { name: "task_index", data: [0], type: "INT32" },
      { name: "task", data: [task], type: "STRING" },
    ],
  });

  writeJson(join(destDir, "meta", "info.json"), {
    codebase_version: "v3.0",
    robot_type: info.robot_type ?? "so_arm100",
    fps: FPS,
    total_episodes: 1,
    total_frames: frames,
    total_tasks: 1,
    total_chunks: 1,
    chunks_size: 1000,
    data_path: "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet",
    video_path: "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4",
    features: info.features,
    thenar_fixture: true,
  });

  return { episodeIndex: 0, sourceEpisodeIndex, frames, sigmaDeg };
}
