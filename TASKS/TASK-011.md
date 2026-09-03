# T-011 — LeRobot v3 dataset reader (read-only)

**Tier:** STRONG. Parsing a real external format; no writes, no encoding.

## Objective
Given a dataset directory (or the stored uploads for a `Dataset`), enumerate
episodes and, for each, produce the container-file set and `range` per PLAN
§9.1 — without modifying, slicing or re-encoding anything (D-18).

## Context
LeRobot v3 layout: `meta/info.json` (fps, features, `data_path`/`video_path`
templates, `codebase_version`), `meta/episodes/chunk-XXX/file-XXX.parquet`
(per-episode metadata incl. `episode_index`, `length`, data/video file
locations and per-episode frame/timestamp ranges), `meta/tasks.parquet`,
`data/chunk-XXX/file-XXX.parquet`, `videos/<camera>/chunk-XXX/file-XXX.mp4`.
Older v2.1 datasets have per-episode files (`layout: per_episode`).

## Dependencies
T-015 (to read stored uploads); T-002 (`FileEntry`).

## Files
- Create `services/api/src/ingest/lerobot.ts`, `test/lerobot.test.ts`, `test/fixtures/lerobot-v3/` (tiny committed dataset: 3 episodes, 1 camera, ≤ 30 frames, generated once by a Python script `scripts/fixtures/make_lerobot_fixture.py` using the `lerobot` package; the generated files are committed so the TS tests need no Python).
- Dep: `hyparquet` (read-only parquet).

## Interfaces
```ts
export type EpisodeRef = { episodeIndex: number; layout: "chunked"|"per_episode"; files: FileEntry[]; range: Range | null; frames: number; rateHz: number; durationMs: number; instruction: string | null; channels: Channel[]; embodiment: string | null; success: boolean | null };
export async function readDataset(dir: string): Promise<{ info: unknown; infoJsonHash: Hex; episodes: EpisodeRef[] }>;
export async function readEpisodeFrames(ref: EpisodeRef, dir: string, columns: string[]): Promise<Record<string, Float32Array | Float64Array | number[]>>;  // rows filtered by episode_index / range
```

## Expected behaviour
- `channels` derived from `info.features` (name, dtype, shape, hz = fps; video features → `video/mp4`), **sorted by name**.
- `files` = the data chunk file + each video file that contains the episode, with hashes from stored uploads or computed via T-002; **sorted by path**.
- `range.frames = [start, end)` within the chunk; `range.video[camera] = [t0, t1]` seconds from episode metadata.
- `embodiment` from `info.robot_type` if present.
- `success` from a boolean column named `success`/`next.success` if present, else null.

## Edge cases
Missing videos; `fps` absent; datasets with `codebase_version` < 3
(per-episode layout; ranges null); an episode whose metadata references a
missing file → error for that episode only.

## Tests
Fixture yields 3 `EpisodeRef`s with expected files/ranges; `readEpisodeFrames`
returns the right row count; v2.1 fixture path handled.

## Acceptance
`pnpm test:api` green; a public HF dataset reads end to end on a dev machine (command in `docs/OPERATIONS.md`).

## Security
Directory traversal rejected; never mutate the source.
