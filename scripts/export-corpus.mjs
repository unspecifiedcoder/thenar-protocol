/** Export a real corpus from the live log as LeRobotDataset v3. */
import { readFileSync } from "node:fs";
import { LogStore } from "../services/log/src/store.ts";
import { exportCorpus } from "../services/export/src/lerobot.ts";
import { taskId } from "../packages/protocol/src/taskspec.ts";

const spec = JSON.parse(readFileSync("apps/web/sample-task.json", "utf8")).spec;
const tid = taskId(spec);
const store = new LogStore(process.env.THENAR_LOG_DB ?? ".data/log.db");
const out = process.argv[2] ?? ".data/corpus";
const r = exportCorpus({ store, taskId: tid, spec, outDir: out, successOnly: true, minQualityBps: 5500 });
store.close();
console.log(`exported ${r.episodes} episodes, ${r.totalFrames} frames -> ${r.dir}`);
console.log(`  ${r.files.length} files`);
console.log(`  robot ${r.info.robot_type}, ${r.info.fps} Hz, format ${r.info.data_format}`);
