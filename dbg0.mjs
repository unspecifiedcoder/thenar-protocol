import { readDataset } from "./services/api/src/ingest/lerobot.ts";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "dbg0-"));
mkdirSync(join(dir, "meta"), { recursive: true });
writeFileSync(join(dir, "meta/info.json"), JSON.stringify({ codebase_version: "v3.0", fps: 30, features: {}, robot_type: "so_arm100" }));
try {
  const r = await readDataset(dir);
  console.log("episodes", r.episodes.length);
} catch (e) {
  console.error("ERR", e);
}
