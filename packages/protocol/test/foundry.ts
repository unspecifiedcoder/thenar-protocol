/** Self-checks for the TaskSpec, the sampler and the embodiment registry. */
import { keccak256, toHex, type Hex } from "viem";
import { validateTaskSpec, taskId, canonicalise, type TaskSpec } from "../src/taskspec";
import { sampleScene, sceneHash } from "../src/sampler";
import { EMBODIMENTS, byId, byClass } from "../src/embodiments";

let fails = 0;
const ok = (c: boolean, m: string, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };

const base = (): TaskSpec => ({
  version: 1,
  embodiment: "franka_panda",
  actionSpace: "ee_pose_gripper",
  instruction: "Place the mug upright on the shelf",
  world: {
    base: "kitchen_counter_v2",
    objects: [
      { category: "mug", instances: ["mug_a", "mug_b", "mug_c"],
        x: [0.28, 0.42], y: [-0.15, 0.15], yaw: [0, 6.283] },
      { category: "distractor", instances: ["box", "can"], x: [0.1, 0.5], y: [-0.3, 0.3], count: [0, 3] },
    ],
    lightingIntensity: [0.6, 1.4],
  },
  success: { predicate: "upright_on(mug, shelf) && settled(2.0)", toleranceMm: 25, settleS: 2 },
  acceptance: { minScoreBps: 5500, maxDurationS: 120, targetEpisodes: 500 },
});

// ------------------------------------------------------------- validation
ok(validateTaskSpec(base()).filter((i) => i.severity === "error").length === 0,
   "a well-formed task validates clean");

const fixed = base();
fixed.world.objects = [{ category: "mug", instances: ["mug_a"], x: [0.3, 0.3], y: [0, 0] }];
delete fixed.world.lightingIntensity;
const fixedErr = validateTaskSpec(fixed).filter((i) => i.severity === "error");
ok(fixedErr.some((e) => /no variation/.test(e.message)),
   "a task with no variation is rejected as a demo, not a dataset");

const badPred = base();
badPred.success.predicate = "looks_good(mug)";
ok(validateTaskSpec(badPred).some((i) => /not machine-checkable/.test(i.message)),
   "a predicate outside the vocabulary is rejected");

const humanoidJoints = base();
humanoidJoints.embodiment = "unitree_g1";
humanoidJoints.actionSpace = "joint_position";
ok(validateTaskSpec(humanoidJoints).some((i) => /high-DoF/.test(i.message)),
   "a humanoid cannot be published as joint_position");

const shortTarget = base();
shortTarget.acceptance.targetEpisodes = 10;
ok(validateTaskSpec(shortTarget).some((i) => i.severity === "warning" && /pilot/.test(i.message)),
   "a tiny target episode count warns");

const badRange = base();
badRange.world.objects[0].x = [0.5, 0.1];
ok(validateTaskSpec(badRange).some((i) => /min above max/.test(i.message)),
   "an inverted range is rejected");

// ------------------------------------------------------------- canonical id
const a = base();
const b: TaskSpec = JSON.parse(JSON.stringify(base()));
ok(taskId(a) === taskId(b), "the same task hashes to the same id");

const reordered = { ...base(), acceptance: base().acceptance, version: 1 as const };
ok(taskId(reordered) === taskId(a), "key order does not change the id");

const widened = base();
widened.world.objects[0].x = [0.28, 0.45];
ok(taskId(widened) !== taskId(a), "widening a range produces a different task");
// Content legitimately contains spaces and commas — "upright_on(mug, shelf)"
// has both. What must not appear is whitespace *between tokens*, so strip the
// string literals first and check what is left of the structure.
const canon = canonicalise(a);
const structure = canon.replace(/"(?:[^"\\]|\\.)*"/g, '""');
ok(!/\s/.test(structure),
   "canonical form carries no whitespace outside string literals",
   `${structure.length} structural chars`);

// ------------------------------------------------------------- the sampler
const id = taskId(a);
const s1 = sampleScene(a, id, 42n);
const s2 = sampleScene(a, id, 42n);
ok(sceneHash(s1) === sceneHash(s2), "the same seed rebuilds the identical scene");

const s3 = sampleScene(a, id, 43n);
ok(sceneHash(s1) !== sceneHash(s3), "a different seed gives a different scene");

const mug = s1.objects.find((o) => o.category === "mug")!;
ok(mug.x >= 0.28 && mug.x <= 0.42, "sampled pose sits inside the authored range", `x=${mug.x.toFixed(4)}`);
ok(["mug_a", "mug_b", "mug_c"].includes(mug.instance), "sampled instance comes from the declared set", mug.instance);

// Variation must actually be observed across seeds, not merely permitted.
const xs = new Set<string>();
const instances = new Set<string>();
let counts = new Set<number>();
for (let i = 0n; i < 200n; i++) {
  const s = sampleScene(a, id, i);
  const m = s.objects.find((o) => o.category === "mug")!;
  xs.add(m.x.toFixed(4));
  instances.add(m.instance);
  counts.add(s.objects.filter((o) => o.category === "distractor").length);
}
// x spans [0.28,0.42] and is bucketed to 4dp, so 1400 buckets and 200 draws
// gives ~14 expected collisions by the birthday bound. Anything near 200 is
// healthy; a low number would mean the stream is repeating.
ok(xs.size > 170, "poses vary across 200 episodes", `${xs.size} distinct of 200`);
ok(instances.size === 3, "every declared instance is reachable", `${instances.size}/3`);
ok(counts.size === 4, "distractor count spans its whole range", `${[...counts].sort().join(",")}`);

const other = sampleScene(a, keccak256(toHex("a-different-task")) as Hex, 42n);
ok(sceneHash(other) !== sceneHash(s1), "the same seed under a different task differs");

// ---------------------------------------------------------- the registry
ok(EMBODIMENTS.length === 58, "the registry carries every Menagerie model", `${EMBODIMENTS.length}`);
ok(byClass("humanoid").length === 11, "eleven humanoids");
ok(byClass("arm").length === 20, "twenty arms");
const permissive = /^(MIT|Apache-2\.0|BSD-2-Clause|BSD-3-Clause|BSD-3-Clause-Clear)$/;
ok(EMBODIMENTS.every((e) => permissive.test(e.licence)),
   "every model is permissively licensed and commercially usable");
ok(EMBODIMENTS.every((e) => e.id && e.menagerie && e.actionSpaces.length > 0),
   "every entry names its model directory and its allowed action spaces");
ok(new Set(EMBODIMENTS.map((e) => e.id)).size === EMBODIMENTS.length, "ids are unique");
ok(byId("unitree_g1")!.dof === 43, "the G1 is recorded at 43 DoF");
ok(!byId("unitree_g1")!.actionSpaces.includes("joint_position"),
   "the G1 does not offer joint_position — a cursor cannot drive 43 joints");

console.log(fails === 0 ? "\nfoundry library: all checks passed\n" : `\n${fails} check(s) failed\n`);
process.exit(fails ? 1 : 0);
