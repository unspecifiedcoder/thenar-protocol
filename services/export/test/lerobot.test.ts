/** The exporter, against the real log store. */
import { readFileSync, rmSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, toHex, type Hex } from "viem";
import { LogStore } from "../../log/src/store.ts";
import { exportCorpus } from "../src/lerobot.ts";
import { encodeEpisode, hashEpisodeLeaf } from "../../../packages/protocol/src/episode.ts";
import { taskId as computeTaskId } from "../../../packages/protocol/src/taskspec.ts";

let fails = 0;
const ok = (c: boolean, m: string, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };
const h = (s: string): Hex => keccak256(toHex(s));

const spec: any = {
  version: 1, embodiment: "franka_panda", actionSpace: "ee_pose_gripper",
  instruction: "Place the mug upright on the shelf",
  world: { base: "kitchen", objects: [{ category: "mug", instances: ["a","b"], x: [0,1], y: [0,1] }] },
  success: { predicate: "upright_on(mug, shelf)", toleranceMm: 25, settleS: 2 },
  acceptance: { minScoreBps: 5500, maxDurationS: 120, targetEpisodes: 500 },
};
const tid = computeTaskId(spec);

const dbPath = join(mkdtempSync(join(tmpdir(), "thenar-export-")), "log.db");
const store = new LogStore(dbPath);
const mk = (i: number, success: boolean, score: number) => {
  const pre = encodeEpisode({
    payloadHash: h(`p${i}`), manifestHash: h("m"), consentCommitment: h(`c${i}`),
    termsId: h("terms"), taskId: tid, capturedAt: 1787000000n, submittedAt: 1787000060n,
    durationMs: 4000, scopeBits: 11, channels: 6,
    worldSeed: BigInt(i), successFlag: success ? 1 : 0, qualityScore: score,
  });
  store.append(hashEpisodeLeaf(pre), { preimage: pre, taskId: tid, qualityScore: score, success: success ? 1 : 0 });
};
for (let i = 0; i < 5; i++) mk(i, true, 6000 + i * 400);
mk(5, false, 1800);
mk(6, true, 5000);   // below a 5500 bar
store.recordAnchor(0, store.root(), store.size(), `0x${"00".repeat(32)}` as Hex, "0xtx", 100);

const out = join(mkdtempSync(join(tmpdir(), "thenar-out-")), "corpus");
const r = exportCorpus({ store, taskId: tid, spec, outDir: out });
ok(r.episodes === 7, "every stored episode exports by default", `${r.episodes}`);
ok(r.totalFrames > 0, "frames are written", `${r.totalFrames}`);

const info = JSON.parse(readFileSync(join(out, "meta/info.json"), "utf8"));
ok(info.codebase_version === "v3.0", "declares LeRobot v3");
ok(info.robot_type === "franka_panda", "names the embodiment");
ok(info.fps === 20, "declares the control rate");
ok(info.data_format === "jsonl" && info.data_path.endsWith(".jsonl"),
   "says jsonl rather than claiming parquet it did not write");
ok(info.video_path === null, "no video track is claimed when none exists");
ok(info.thenar.task_spec.instruction === spec.instruction, "carries the task spec");
ok(info.thenar.embodiment.licence === "Apache-2.0", "carries the model licence a buyer must check");
ok(/Simulated capture/.test(info.thenar.note), "says plainly that this is simulated");

const eps = readFileSync(join(out, "meta/episodes.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
ok(eps.length === 7, "one metadata row per episode");
ok(eps.every((e) => e.thenar.leaf && e.thenar.task_id === tid), "every episode carries its leaf and task");
ok(eps.every((e) => e.thenar.anchor_root !== null), "every episode names the anchor that fixed it");
ok(eps.every((e) => typeof e.thenar.world_seed === "string"), "world seed survives as a string, not a lossy number");
ok(eps.filter((e) => !e.thenar.success).length === 1, "failed attempts are kept and marked");

// Filters a buyer actually uses.
const good = exportCorpus({ store, taskId: tid, spec, outDir: out + "-ok", successOnly: true });
ok(good.episodes === 6, "successOnly drops the failed attempt", `${good.episodes}`);
const strict = exportCorpus({ store, taskId: tid, spec, outDir: out + "-strict", successOnly: true, minQualityBps: 5500 });
ok(strict.episodes === 5, "a quality bar drops the weak episode too", `${strict.episodes}`);

// An empty export must fail loudly rather than ship a corpus that is not one.
let refused = false;
try { exportCorpus({ store, taskId: tid, spec, outDir: out + "-none", minQualityBps: 9999 }); }
catch (e) { refused = /would ship a corpus that is not one/.test((e as Error).message); }
ok(refused, "an empty corpus is refused, loudly");

let unknown = false;
try { exportCorpus({ store, taskId: h("no-such-task"), spec, outDir: out + "-x" }); }
catch { unknown = true; }
ok(unknown, "a task with no episodes is refused");

const frames = readFileSync(join(out, "data/episode_000000.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
ok(frames.length === eps[0].length, "the frame count matches the episode metadata", `${frames.length}`);
ok(frames[0].timestamp === 0 && frames[frames.length - 1].next_done === true,
   "frames run from t=0 to a terminal step");
ok(frames.every((f) => f["observation.state"] === null),
   "observation is null, not zero-filled — there is no recorder yet and a zero would read as data");

store.close();
console.log(fails === 0 ? "\nlerobot export: all checks passed\n" : `\n${fails} check(s) failed\n`);
process.exit(fails ? 1 : 0);
