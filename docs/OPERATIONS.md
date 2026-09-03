# Operations

Runbooks that don't belong in `PLAN.md` (the protocol spec) or a task file.

## Reading a public dataset

`services/api/src/ingest/lerobot.ts` (T-011) reads a LeRobot-layout dataset
directory read-only — it enumerates episodes and, for each, the container
files and `range` PLAN §9.1 wants for a `CaptureManifest`. It never writes,
slices or re-encodes anything (D-18), and it never decodes video.

Tests run against tiny fixtures committed under
`services/api/test/fixtures/` — no network access at test time. To read a
real public Hugging Face dataset end to end on a dev machine:

1. Download the dataset locally (`huggingface-cli` or `git lfs clone`), e.g.:
   ```sh
   pip install huggingface_hub
   huggingface-cli download <org>/<dataset> --repo-type dataset --local-dir ./tmp/some-dataset
   ```
   This produces the standard LeRobot layout (`meta/info.json`,
   `meta/episodes/...` or `meta/episodes.jsonl`, `data/...`, `videos/...`)
   under `./tmp/some-dataset`.

2. Point the reader at that directory:
   ```sh
   npx tsx -e '
     import { readDataset } from "./services/api/src/ingest/lerobot.ts";
     const { info, infoJsonHash, episodes } = await readDataset("./tmp/some-dataset");
     console.log("codebase_version:", (info as any).codebase_version);
     console.log("infoJsonHash:", infoJsonHash);
     console.log("episodes:", episodes.length);
     console.log(episodes[0]);
   '
   ```

3. To read a specific episode's frames:
   ```sh
   npx tsx -e '
     import { readDataset, readEpisodeFrames } from "./services/api/src/ingest/lerobot.ts";
     const { episodes } = await readDataset("./tmp/some-dataset");
     const frames = await readEpisodeFrames(episodes[0], "./tmp/some-dataset", ["observation.state", "action"]);
     console.log(Object.keys(frames), (frames["observation.state"] as number[]).length);
   '
   ```

Both LeRobot v3 (`"chunked"`, several episodes sharing a data/video chunk,
`range` non-null) and pre-v3 (`"per_episode"`, one file per episode,
`range` null) layouts are handled; `codebase_version`'s major version
number picks the branch.
