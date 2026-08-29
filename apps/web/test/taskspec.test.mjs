/** The browser validator and hasher must equal the exporter's, exactly. */
import { readFileSync } from "node:fs";
import { validateTaskSpec as bValidate, taskId as bTaskId, canonicalise as bCanon,
         PREDICATES as bPred, ACTION_SPACES as bActions } from "../taskspec.js";
import { validateTaskSpec as nValidate, taskId as nTaskId, canonicalise as nCanon,
         PREDICATES as nPred, ACTION_SPACES as nActions } from "../../../packages/protocol/src/taskspec.ts";

let fails = 0;
const ok = (c, m, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };

ok(JSON.stringify(bPred) === JSON.stringify(nPred), "the predicate vocabulary matches");
ok(JSON.stringify(bActions) === JSON.stringify(nActions), "the action spaces match");

const base = JSON.parse(readFileSync(new URL("../../../packages/protocol/test/fixture-task.json", import.meta.url), "utf8"));
ok(bTaskId(base) === nTaskId(base), "a valid spec hashes identically", bTaskId(base).slice(0, 14) + "…");
ok(bCanon(base) === nCanon(base), "and canonicalises identically");

// Key order must not change the id, or two curators authoring the same task
// would publish two different ones.
const shuffled = JSON.parse(JSON.stringify(base));
const reordered = { acceptance: shuffled.acceptance, world: shuffled.world, success: shuffled.success,
                    instruction: shuffled.instruction, actionSpace: shuffled.actionSpace,
                    embodiment: shuffled.embodiment, version: shuffled.version };
ok(bTaskId(reordered) === bTaskId(base), "reordering the keys does not change the id");

const cases = [
  ["valid", base],
  ["no variation", { ...base, world: { ...base.world, objects: [{ category: "mug", instances: ["a"], x: [0.3, 0.3], y: [0, 0] }], lightingIntensity: [1, 1], lightingTemperatureK: [5000, 5000] } }],
  ["bad predicate", { ...base, success: { ...base.success, predicate: "looks_right(mug)" } }],
  ["no objects", { ...base, world: { ...base.world, objects: [] } }],
  ["short instruction", { ...base, instruction: "do it" }],
  ["inverted range", { ...base, world: { ...base.world, objects: [{ category: "mug", instances: ["a", "b"], x: [0.5, 0.1], y: [0, 1] }] } }],
  ["bad action space", { ...base, actionSpace: "telepathy" }],
  ["humanoid joint control", { ...base, embodiment: "unitree_g1", actionSpace: "joint_position" }],
  ["tiny target", { ...base, acceptance: { ...base.acceptance, targetEpisodes: 10 } }],
  ["score out of range", { ...base, acceptance: { ...base.acceptance, minScoreBps: 20000 } }],
  ["negative tolerance", { ...base, success: { ...base.success, toleranceMm: -1 } }],
];
let same = true;
for (const [name, spec] of cases) {
  const b = JSON.stringify(bValidate(spec)), n = JSON.stringify(nValidate(spec));
  if (b !== n) { same = false; console.log(`    "${name}" differs:\n      browser  ${b}\n      exporter ${n}`); }
}
ok(same, "every validation case produces the same issues", `${cases.length} cases`);

ok(bValidate(base).length === 0, "the fixture is valid");
ok(bValidate(cases[1][1]).some((i) => /no variation/.test(i.message)), "a fixed arrangement is refused");
ok(bValidate(cases[7][1]).some((i) => /high-DoF/.test(i.message)), "a humanoid cannot be joint-driven from a cursor");
ok(bValidate(cases[8][1]).some((i) => i.severity === "warning"), "a small target warns rather than fails");

console.log(fails === 0 ? "\ntaskspec: browser and exporter agree\n" : `\n${fails} check(s) failed\n`);
process.exit(fails ? 1 : 0);
