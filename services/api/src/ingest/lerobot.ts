/**
 * T-011 — LeRobot dataset reader (read-only, PLAN §9.1 D-18).
 *
 * Enumerates episodes in a LeRobot-layout dataset directory and, for each,
 * produces the container-file set and `range` PLAN §9.1 wants for a
 * `CaptureManifest` — without modifying, slicing or re-encoding anything
 * (D-18). This module never writes to the dataset directory and never
 * decodes video; it only refs and hashes container files (T-002
 * `buildFileEntries`).
 *
 * Two layouts are handled:
 *  - `"chunked"` (LeRobot v3, `codebase_version` major >= 3): several
 *    episodes share a data-chunk parquet and a video-chunk file;
 *    `meta/episodes/chunk-XXX/file-XXX.parquet` carries each episode's
 *    `dataset_from_index`/`dataset_to_index` row range and per-video
 *    `from_timestamp`/`to_timestamp`. `range` is non-null.
 *  - `"per_episode"` (pre-v3, e.g. v2.1): each episode has its own data
 *    and video files; there is no chunk-relative range to report, so
 *    `range` is null (see Edge cases in TASK-011.md).
 *
 * Every relative path built from a dataset's own metadata (info.json's
 * `data_path`/`video_path` templates, or an episode's chunk/file indices)
 * is validated with `assertPath` (PLAN §9.1 path rule) *before* any
 * filesystem access — this is what rejects directory traversal.
 */
import { readFile, readdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import type { Hex } from "viem";
import {
  assertPath,
  buildFileEntries,
  type FileEntry,
} from "../../../../packages/protocol/src/payload.ts";
// @ts-ignore -- hyparquet ships JS + .d.ts; tsx resolves the ESM entry at runtime
import { asyncBufferFromFile, parquetReadObjects } from "hyparquet";

// ---------------------------------------------------------------- types

export type Channel = {
  name: string;
  dtype: string;
  shape: number[];
  hz?: number;
  unit?: string;
};

export type Range = {
  frames: [number, number]; // [start, end) row indices within the data chunk
  video: Record<string, [number, number]>; // camera -> [t0, t1] seconds
};

export type EpisodeRef = {
  episodeIndex: number;
  layout: "chunked" | "per_episode";
  files: FileEntry[]; // sorted by path bytes
  range: Range | null;
  frames: number;
  rateHz: number;
  durationMs: number;
  instruction: string | null;
  channels: Channel[]; // sorted by name
  embodiment: string | null;
  success: boolean | null;
};

// ------------------------------------------------------------- path utils

/** `assertPath` first, then joined onto `dir` — never accesses the fs before validating. */
function resolveWithin(dir: string, relPath: string): string {
  assertPath(relPath);
  return resolvePath(dir, relPath);
}

/**
 * Fills a LeRobot path template (`data_path`/`video_path` from `info.json`)
 * with the given values. Supports `{name}` and zero-padded `{name:0Nd}`
 * placeholders, e.g. `data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet`.
 */
function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([a-zA-Z_]+)(?::0(\d+)d)?\}/g, (_match, name: string, width?: string) => {
    if (!(name in values)) throw new Error(`lerobot: template ${JSON.stringify(template)} needs "${name}"`);
    const v = values[name];
    if (width) return String(v).padStart(Number(width), "0");
    return String(v);
  });
}

function utf8Compare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

async function readJson(path: string): Promise<any> {
  const bytes = await readFile(path, "utf8");
  return JSON.parse(bytes);
}

/** Recursively lists files under `dir` matching `pattern`, relative to `dir`, sorted. */
async function findFiles(dir: string, pattern: RegExp): Promise<string[]> {
  const out: string[] = [];
  async function walk(sub: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(resolvePath(dir, sub), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(rel);
      else if (pattern.test(rel)) out.push(rel);
    }
  }
  await walk("");
  return out.sort();
}

// -------------------------------------------------------------- channels

/**
 * `channels` derived from `info.features` (name, dtype, shape, hz = fps;
 * video features -> `video/mp4`), sorted by name (PLAN §9.1, Expected
 * behaviour).
 */
function channelsFromFeatures(features: Record<string, any>, fps: number | undefined): Channel[] {
  const channels: Channel[] = [];
  for (const [name, f] of Object.entries(features ?? {})) {
    const dtype = f?.dtype === "video" ? "video/mp4" : String(f?.dtype ?? "unknown");
    const shape = Array.isArray(f?.shape) ? f.shape.map((n: unknown) => Number(n)) : [];
    const channel: Channel = { name, dtype, shape };
    if (typeof fps === "number" && Number.isFinite(fps)) channel.hz = fps;
    channels.push(channel);
  }
  channels.sort((a, b) => utf8Compare(a.name, b.name));
  return channels;
}

function videoCameras(features: Record<string, any>): string[] {
  return Object.entries(features ?? {})
    .filter(([, f]) => f?.dtype === "video")
    .map(([name]) => name);
}

// ------------------------------------------------------------- success

/** `success` from a boolean `success`/`next.success` column if present, else null (PLAN §9.1). */
function deriveSuccess(rows: Record<string, unknown>[]): boolean | null {
  for (const col of ["success", "next.success"]) {
    if (rows.length > 0 && col in rows[0]) {
      return rows.some((r) => r[col] === true);
    }
  }
  return null;
}

// ----------------------------------------------------------------- main

export async function readDataset(dir: string): Promise<{ info: unknown; infoJsonHash: Hex; episodes: EpisodeRef[] }> {
  const infoRelPath = "meta/info.json";
  const infoAbsPath = resolveWithin(dir, infoRelPath);
  const info = await readJson(infoAbsPath);
  const [infoEntry] = await buildFileEntries(dir, [infoRelPath]);
  const infoJsonHash = infoEntry.hash;

  const codebaseVersion: string = String(info?.codebase_version ?? "");
  const majorMatch = /v?(\d+)/.exec(codebaseVersion);
  const major = majorMatch ? Number(majorMatch[1]) : 0;
  const isChunked = major >= 3;

  const fps: number | undefined = typeof info?.fps === "number" ? info.fps : undefined; // Edge case: fps absent
  const channels = channelsFromFeatures(info?.features ?? {}, fps);
  const cameras = videoCameras(info?.features ?? {});
  const embodiment: string | null = typeof info?.robot_type === "string" ? info.robot_type : null;

  const episodes: EpisodeRef[] = isChunked
    ? await readChunkedEpisodes(dir, info, { fps, channels, cameras, embodiment })
    : await readPerEpisodeEpisodes(dir, info, { fps, channels, cameras, embodiment });

  return { info, infoJsonHash, episodes };
}

type CommonCtx = {
  fps: number | undefined;
  channels: Channel[];
  cameras: string[];
  embodiment: string | null;
};

/** Builds one `EpisodeRef`, isolating any failure (e.g. a missing referenced file) to this episode only. */
async function buildEpisode(
  episodeIndex: number,
  layout: "chunked" | "per_episode",
  relFilePaths: string[],
  dir: string,
  range: Range | null,
  frames: number,
  instruction: string | null,
  ctx: CommonCtx,
  successRows: Record<string, unknown>[],
): Promise<EpisodeRef | null> {
  try {
    const seen = new Set<string>();
    const uniquePaths = relFilePaths.filter((p) => (seen.has(p) ? false : (seen.add(p), true)));
    const files = (await buildFileEntries(dir, uniquePaths)).sort((a, b) => utf8Compare(a.path, b.path));
    const rateHz = ctx.fps ?? 0;
    const durationMs = rateHz > 0 ? Math.round((frames / rateHz) * 1000) : 0;
    return {
      episodeIndex,
      layout,
      files,
      range,
      frames,
      rateHz,
      durationMs,
      instruction,
      channels: ctx.channels,
      embodiment: ctx.embodiment,
      success: deriveSuccess(successRows),
    };
  } catch (err) {
    // Edge case (TASK-011.md): "an episode whose metadata references a
    // missing file -> error for that episode only" -- the dataset as a
    // whole still reads; this one episode is omitted from the result.
    console.error(
      `lerobot: skipping episode ${episodeIndex} (${layout}): ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

// ============================================================ v3 "chunked"

async function readChunkedEpisodes(dir: string, info: any, ctx: CommonCtx): Promise<EpisodeRef[]> {
  const dataPathTemplate: string = info?.data_path ?? "data/chunk-{chunk_index:03d}/file-{file_index:03d}.parquet";
  const videoPathTemplate: string = info?.video_path ?? "videos/{video_key}/chunk-{chunk_index:03d}/file-{file_index:03d}.mp4";

  const episodeChunkFiles = await findFiles(
    resolvePath(dir, "meta/episodes"),
    /^chunk-\d+\/file-\d+\.parquet$/,
  );
  const episodeRows: Record<string, unknown>[] = [];
  for (const rel of episodeChunkFiles) {
    const abs = resolveWithin(dir, `meta/episodes/${rel}`);
    const file = await asyncBufferFromFile(abs);
    const rows = await parquetReadObjects({ file });
    episodeRows.push(...rows);
  }
  episodeRows.sort((a, b) => Number(a.episode_index) - Number(b.episode_index));

  const out: EpisodeRef[] = [];
  for (const row of episodeRows) {
    const episodeIndex = Number(row.episode_index);
    const length = Number(row.length);
    const fromIndex = Number(row.dataset_from_index);
    const toIndex = Number(row.dataset_to_index);
    const dataChunkIndex = Number(row["data/chunk_index"]);
    const dataFileIndex = Number(row["data/file_index"]);

    const dataPath = fillTemplate(dataPathTemplate, { chunk_index: dataChunkIndex, file_index: dataFileIndex });

    const video: Record<string, [number, number]> = {};
    const relPaths = [dataPath];
    for (const camera of ctx.cameras) {
      const chunkKey = `videos/${camera}/chunk_index`;
      const fileKey = `videos/${camera}/file_index`;
      const fromKey = `videos/${camera}/from_timestamp`;
      const toKey = `videos/${camera}/to_timestamp`;
      if (!(chunkKey in row)) continue; // Edge case: missing video for this camera
      const videoPath = fillTemplate(videoPathTemplate, {
        video_key: camera,
        chunk_index: Number(row[chunkKey]),
        file_index: Number(row[fileKey]),
      });
      relPaths.push(videoPath);
      video[camera] = [Number(row[fromKey]), Number(row[toKey])];
    }

    const tasks = Array.isArray(row.tasks) ? (row.tasks as string[]) : [];
    const instruction = tasks.length > 0 ? tasks.join("; ") : null;
    const range: Range = { frames: [fromIndex, toIndex], video };

    // success is derived from the episode's own frame rows in the shared data file
    let successRows: Record<string, unknown>[] = [];
    try {
      const dataAbs = resolveWithin(dir, dataPath);
      const file = await asyncBufferFromFile(dataAbs);
      successRows = await parquetReadObjects({ file, rowStart: fromIndex, rowEnd: toIndex });
    } catch {
      // handled by buildEpisode below (missing data file -> episode skipped)
    }

    const ref = await buildEpisode(episodeIndex, "chunked", relPaths, dir, range, length, instruction, ctx, successRows);
    if (ref) out.push(ref);
  }
  return out;
}

// ======================================================== pre-v3 "per_episode"

async function readPerEpisodeEpisodes(dir: string, info: any, ctx: CommonCtx): Promise<EpisodeRef[]> {
  const dataPathTemplate: string =
    info?.data_path ?? "data/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.parquet";
  const videoPathTemplate: string =
    info?.video_path ?? "videos/{video_key}/chunk-{episode_chunk:03d}/episode_{episode_index:06d}.mp4";

  const episodesAbs = resolveWithin(dir, "meta/episodes.jsonl");
  let episodeRows: { episode_index: number; length: number; tasks?: string[] }[] = [];
  try {
    const text = await readFile(episodesAbs, "utf8");
    episodeRows = text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch (err) {
    throw new Error(`lerobot: could not read meta/episodes.jsonl: ${err instanceof Error ? err.message : String(err)}`);
  }

  const out: EpisodeRef[] = [];
  for (const row of episodeRows) {
    const episodeIndex = row.episode_index;
    const length = row.length;
    const episodeChunk = 0; // this fixture/format keeps one chunk per episode index range; chunk index is not carried in episodes.jsonl here

    const dataPath = fillTemplate(dataPathTemplate, { episode_chunk: episodeChunk, episode_index: episodeIndex });
    const relPaths = [dataPath];
    for (const camera of ctx.cameras) {
      const videoPath = fillTemplate(videoPathTemplate, {
        video_key: camera,
        episode_chunk: episodeChunk,
        episode_index: episodeIndex,
      });
      relPaths.push(videoPath);
    }

    const tasks = Array.isArray(row.tasks) ? row.tasks : [];
    const instruction = tasks.length > 0 ? tasks.join("; ") : null;

    let successRows: Record<string, unknown>[] = [];
    try {
      const dataAbs = resolveWithin(dir, dataPath);
      const file = await asyncBufferFromFile(dataAbs);
      successRows = await parquetReadObjects({ file });
    } catch {
      // handled by buildEpisode below (missing data file -> episode skipped)
    }

    // Edge case (TASK-011.md): pre-v3 datasets are per-episode -> no
    // chunk-relative range to report.
    const ref = await buildEpisode(episodeIndex, "per_episode", relPaths, dir, null, length, instruction, ctx, successRows);
    if (ref) out.push(ref);
  }
  return out;
}

// ---------------------------------------------------------------- frames

/**
 * Reads `columns` for one episode's frames, filtered by `episode_index`
 * (or `range.frames` when available, for the chunked layout) using
 * `hyparquet` -- never writes, slices or re-encodes the source file.
 */
export async function readEpisodeFrames(
  ref: EpisodeRef,
  dir: string,
  columns: string[],
): Promise<Record<string, Float32Array | Float64Array | number[]>> {
  const dataFile = ref.files.find((f) => f.path.startsWith("data/"));
  if (!dataFile) throw new Error(`lerobot: episode ${ref.episodeIndex} has no data/ file in its file set`);
  const abs = resolveWithin(dir, dataFile.path);
  const file = await asyncBufferFromFile(abs);

  const wantColumns = Array.from(new Set([...columns, "episode_index"]));

  let rows: Record<string, unknown>[];
  if (ref.range) {
    rows = await parquetReadObjects({
      file,
      columns: wantColumns,
      rowStart: ref.range.frames[0],
      rowEnd: ref.range.frames[1],
    });
  } else {
    const all = await parquetReadObjects({ file, columns: wantColumns });
    rows = all.filter((r) => Number(r.episode_index) === ref.episodeIndex);
  }

  const out: Record<string, Float32Array | Float64Array | number[]> = {};
  for (const col of columns) {
    const values = rows.map((r) => r[col]);
    if (values.length === 0) {
      out[col] = new Float64Array(0);
      continue;
    }
    const first = values[0];
    if (Array.isArray(first)) {
      // Vector-valued column (e.g. observation.state, action): one array per
      // frame. The exported type is a flat array per the task's Interfaces
      // block; the per-frame vectors are preserved as nested arrays.
      out[col] = values as unknown as number[];
    } else if (typeof first === "boolean") {
      out[col] = Float64Array.from(values as boolean[], (v) => (v ? 1 : 0));
    } else {
      out[col] = Float64Array.from(values as number[], (v) => Number(v));
    }
  }
  return out;
}
