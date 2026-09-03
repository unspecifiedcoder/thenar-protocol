/**
 * T-011 fixture generator.
 *
 * TASK-011.md asks for a Python script using the `lerobot` package. That
 * package is not installable in this environment (no Python / no network
 * access to PyPI), so — per supervisor adjustment — this TypeScript script
 * builds the same two tiny, deterministic, committed fixtures directly with
 * `hyparquet-writer` (already a repo dependency):
 *
 *  - `services/api/test/fixtures/lerobot-v3/`  — LeRobot v3.0 "chunked"
 *    layout: 3 episodes packed into one shared data-chunk parquet and one
 *    shared video-chunk file, `meta/episodes/chunk-000/file-000.parquet`
 *    (per-episode ranges) + `meta/tasks.parquet`.
 *  - `services/api/test/fixtures/lerobot-v2/`  — v2.1-style "per_episode"
 *    layout: one episode with its own data/video files,
 *    `meta/episodes.jsonl` + `meta/tasks.jsonl` (the pre-v3 metadata
 *    format — no per-episode parquet index existed yet).
 *
 * Video: a real 1-frame-per-episode-ish MP4 via `ffmpeg` when it is on
 * PATH; otherwise a small deterministic binary blob named `*.mp4`, and
 * `meta/info.json` for that fixture sets `"thenar_fixture": true` to flag
 * that the file is not a decodable video. `services/api/src/ingest/
 * lerobot.ts` never decodes video — it only refs and hashes container
 * files (D-18) — so the blob is sufficient to exercise the reader.
 *
 * Run with: `npx tsx scripts/fixtures/make-lerobot-fixture.ts`
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// @ts-ignore -- hyparquet-writer ships JS + .d.ts under a "node" export condition tsx resolves at runtime
import { parquetWriteFile } from "hyparquet-writer";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const fixturesRoot = join(repoRoot, "services", "api", "test", "fixtures");

// ---------------------------------------------------------------- helpers

function hasFfmpeg(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function writeParquet(path: string, options: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  parquetWriteFile({ filename: path, ...options });
}

function writeJson(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
}

function writeJsonl(path: string, rows: unknown[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
}

/** Real MP4 via ffmpeg when available; otherwise a deterministic fake blob. */
function makeMp4(path: string, ffmpegAvailable: boolean, seed: string, durationS: number): void {
  mkdirSync(dirname(path), { recursive: true });
  if (ffmpegAvailable) {
    execFileSync(
      "ffmpeg",
      [
        "-y",
        "-f", "lavfi",
        "-i", `color=c=blue:s=64x64:r=30:d=${durationS}`,
        "-c:v", "libx264",
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        path,
      ],
      { stdio: "ignore" },
    );
    return;
  }
  const bytes = Buffer.alloc(2048);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (seed.charCodeAt(i % seed.length) + i * 7) & 0xff;
  writeFileSync(path, bytes);
}

/** A generic 3-level `LIST<FLOAT>` schema fragment (see hyparquet-writer's dremel encoder). */
function listFloatSchema(name: string) {
  return [
    { name, repetition_type: "OPTIONAL", converted_type: "LIST", num_children: 1 },
    { name: "list", repetition_type: "REPEATED", num_children: 1 },
    { name: "element", type: "FLOAT", repetition_type: "REQUIRED" },
  ];
}

/** A generic 3-level `LIST<BYTE_ARRAY/UTF8>` schema fragment. */
function listStringSchema(name: string) {
  return [
    { name, repetition_type: "OPTIONAL", converted_type: "LIST", num_children: 1 },
    { name: "list", repetition_type: "REPEATED", num_children: 1 },
    { name: "element", type: "BYTE_ARRAY", converted_type: "UTF8", repetition_type: "REQUIRED" },
  ];
}

const FPS = 30;
const CAMERA = "observation.images.front";

function features(hasThenarFixtureFlag: boolean) {
  return {
    "observation.state": { dtype: "float32", shape: [3], names: null },
    action: { dtype: "float32", shape: [3], names: null },
    [CAMERA]: {
      dtype: "video",
      shape: [64, 64, 3],
      names: ["height", "width", "channel"],
      video_info: { "video.fps": FPS, "video.codec": "h264" },
    },
    "next.success": { dtype: "bool", shape: [1], names: null },
    timestamp: { dtype: "float32", shape: [1], names: null },
    frame_index: { dtype: "int64", shape: [1], names: null },
    episode_index: { dtype: "int64", shape: [1], names: null },
    index: { dtype: "int64", shape: [1], names: null },
    task_index: { dtype: "int64", shape: [1], names: null },
  };
}

// ============================================================ v3 "chunked"

function makeV3Fixture(ffmpegAvailable: boolean): void {
  const root = join(fixturesRoot, "lerobot-v3");
  const episodeLengths = [6, 5, 7]; // 3 episodes, 18 frames total, ≤ 30 (PLAN task budget)
  const episodeTasks = ["fold the towel", "fold the towel", "stack the cups"];
  const taskList = ["fold the towel", "stack the cups"];
  const taskIndexOf = (t: string) => taskList.indexOf(t);

  // ---- data/chunk-000/file-000.parquet: all 18 frames, in episode order ----
  const episodeIndexCol: number[] = [];
  const frameIndexCol: number[] = [];
  const indexCol: number[] = [];
  const timestampCol: number[] = [];
  const taskIndexCol: number[] = [];
  const stateCol: number[][] = [];
  const actionCol: number[][] = [];
  const successCol: boolean[] = [];

  let globalIndex = 0;
  const fromIndex: number[] = [];
  const toIndex: number[] = [];
  for (let ep = 0; ep < episodeLengths.length; ep++) {
    const len = episodeLengths[ep];
    fromIndex.push(globalIndex);
    for (let f = 0; f < len; f++) {
      episodeIndexCol.push(ep);
      frameIndexCol.push(f);
      indexCol.push(globalIndex);
      timestampCol.push(f / FPS);
      taskIndexCol.push(taskIndexOf(episodeTasks[ep]));
      stateCol.push([ep + f * 0.1, ep + f * 0.1 + 1, ep + f * 0.1 + 2]);
      actionCol.push([-(ep + f * 0.1), -(ep + f * 0.1 + 1), -(ep + f * 0.1 + 2)]);
      successCol.push(f === len - 1); // true only on the episode's last frame
      globalIndex++;
    }
    toIndex.push(globalIndex);
  }

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

  writeParquet(join(root, "data", "chunk-000", "file-000.parquet"), {
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

  // ---- videos/<camera>/chunk-000/file-000.mp4: one file spanning all 3 episodes ----
  const totalFrames = episodeLengths.reduce((a, b) => a + b, 0);
  makeMp4(
    join(root, "videos", CAMERA, "chunk-000", "file-000.mp4"),
    ffmpegAvailable,
    "thenar-lerobot-v3-fixture",
    totalFrames / FPS,
  );

  // ---- meta/episodes/chunk-000/file-000.parquet: one row per episode ----
  const epEpisodeIndex: number[] = [];
  const epLength: number[] = [];
  const epFromIndex: number[] = [];
  const epToIndex: number[] = [];
  const epDataChunkIndex: number[] = [];
  const epDataFileIndex: number[] = [];
  const epVideoChunkIndex: number[] = [];
  const epVideoFileIndex: number[] = [];
  const epVideoFrom: number[] = [];
  const epVideoTo: number[] = [];
  const epTasks: string[][] = [];

  for (let ep = 0; ep < episodeLengths.length; ep++) {
    epEpisodeIndex.push(ep);
    epLength.push(episodeLengths[ep]);
    epFromIndex.push(fromIndex[ep]);
    epToIndex.push(toIndex[ep]);
    epDataChunkIndex.push(0);
    epDataFileIndex.push(0);
    epVideoChunkIndex.push(0);
    epVideoFileIndex.push(0);
    epVideoFrom.push(fromIndex[ep] / FPS);
    epVideoTo.push(toIndex[ep] / FPS);
    epTasks.push([episodeTasks[ep]]);
  }

  const episodesSchema = [
    { name: "root", num_children: 10 },
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
  ];
  // "tasks" (list<string>) appended after the fixed columns above; root.num_children
  // covers it too (11 top-level column groups in total).
  episodesSchema[0].num_children = 11;
  episodesSchema.push(...listStringSchema("tasks"));

  writeParquet(join(root, "meta", "episodes", "chunk-000", "file-000.parquet"), {
    schema: episodesSchema,
    columnData: [
      { name: "episode_index", data: epEpisodeIndex },
      { name: "length", data: epLength },
      { name: "dataset_from_index", data: epFromIndex },
      { name: "dataset_to_index", data: epToIndex },
      { name: "data/chunk_index", data: epDataChunkIndex },
      { name: "data/file_index", data: epDataFileIndex },
      { name: `videos/${CAMERA}/chunk_index`, data: epVideoChunkIndex },
      { name: `videos/${CAMERA}/file_index`, data: epVideoFileIndex },
      { name: `videos/${CAMERA}/from_timestamp`, data: epVideoFrom },
      { name: `videos/${CAMERA}/to_timestamp`, data: epVideoTo },
      { name: "tasks", data: epTasks },
    ],
  });

  // ---- meta/tasks.parquet: global task registry ----
  writeParquet(join(root, "meta", "tasks.parquet"), {
    columnData: [
      { name: "task_index", data: taskList.map((_, i) => i), type: "INT32" },
      { name: "task", data: taskList, type: "STRING" },
    ],
  });

  // ---- meta/info.json ----
  writeJson(join(root, "meta", "info.json"), {
    codebase_version: "v3.0",
    robot_type: "so_arm100",
    fps: FPS,
    total_episodes: episodeLengths.length,
    total_frames: totalFrames,
    total_tasks: taskList.length,
    total_chunks: 1,
    chunks_size: 1000,
    data_path: "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet",
    video_path: "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4",
    features: features(!ffmpegAvailable),
    ...(ffmpegAvailable ? {} : { thenar_fixture: true }),
  });

  console.log(`wrote ${root} (ffmpeg: ${ffmpegAvailable})`);
}

// ======================================================== v2.1 "per_episode"

function makeV2Fixture(ffmpegAvailable: boolean): void {
  const root = join(fixturesRoot, "lerobot-v2");
  const length = 5;
  const task = "fold the towel";

  const episodeIndexCol = Array.from({ length }, () => 0);
  const frameIndexCol = Array.from({ length }, (_, i) => i);
  const indexCol = Array.from({ length }, (_, i) => i);
  const timestampCol = Array.from({ length }, (_, i) => i / FPS);
  const taskIndexCol = Array.from({ length }, () => 0);
  const stateCol = Array.from({ length }, (_, i) => [i, i + 1, i + 2]);
  const actionCol = Array.from({ length }, (_, i) => [-i, -(i + 1), -(i + 2)]);
  // Exercise the alternate success-column-name branch (v3 fixture uses "next.success").
  const successCol = Array.from({ length }, (_, i) => i === length - 1);

  const dataSchema = [
    { name: "root", num_children: 8 },
    { name: "episode_index", type: "INT32", repetition_type: "REQUIRED" },
    { name: "frame_index", type: "INT32", repetition_type: "REQUIRED" },
    { name: "index", type: "INT32", repetition_type: "REQUIRED" },
    { name: "timestamp", type: "DOUBLE", repetition_type: "REQUIRED" },
    { name: "task_index", type: "INT32", repetition_type: "REQUIRED" },
    ...listFloatSchema("observation.state"),
    ...listFloatSchema("action"),
    { name: "success", type: "BOOLEAN", repetition_type: "REQUIRED" },
  ];

  writeParquet(join(root, "data", "chunk-000", "episode_000000.parquet"), {
    schema: dataSchema,
    columnData: [
      { name: "episode_index", data: episodeIndexCol },
      { name: "frame_index", data: frameIndexCol },
      { name: "index", data: indexCol },
      { name: "timestamp", data: timestampCol },
      { name: "task_index", data: taskIndexCol },
      { name: "observation.state", data: stateCol },
      { name: "action", data: actionCol },
      { name: "success", data: successCol },
    ],
  });

  makeMp4(
    join(root, "videos", CAMERA, "chunk-000", "episode_000000.mp4"),
    ffmpegAvailable,
    "thenar-lerobot-v2-fixture",
    length / FPS,
  );

  writeJsonl(join(root, "meta", "episodes.jsonl"), [{ episode_index: 0, length, tasks: [task] }]);
  writeJsonl(join(root, "meta", "tasks.jsonl"), [{ task_index: 0, task }]);

  writeJson(join(root, "meta", "info.json"), {
    codebase_version: "v2.1",
    robot_type: "so_arm100",
    fps: FPS,
    total_episodes: 1,
    total_frames: length,
    total_tasks: 1,
    total_chunks: 1,
    chunks_size: 1000,
    data_path: "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet",
    video_path: "videos/{video_key}/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.mp4",
    features: features(!ffmpegAvailable),
    ...(ffmpegAvailable ? {} : { thenar_fixture: true }),
  });

  console.log(`wrote ${root} (ffmpeg: ${ffmpegAvailable})`);
}

// ==================================================================== main

const ffmpegAvailable = hasFfmpeg();
makeV3Fixture(ffmpegAvailable);
makeV2Fixture(ffmpegAvailable);
if (!ffmpegAvailable) {
  console.log(
    "ffmpeg not found on PATH: video files are deterministic binary blobs, not decodable MP4s. " +
      "meta/info.json sets thenar_fixture: true. The reader (services/api/src/ingest/lerobot.ts) " +
      "never decodes video, only refs/hashes container files, so this is sufficient.",
  );
}
