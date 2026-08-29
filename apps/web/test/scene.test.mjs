/**
 * The browser sampler must agree with the exporter's, exactly.
 *
 * If they drift, a reconstruction shown on the site is not the world the
 * episode was recorded in — and the claim that anyone can rebuild it becomes
 * false while still looking fine.
 */
import { readFileSync } from "node:fs";
import { sampleScene as browser, sceneHash as browserHash } from "../scene.js";
import { sampleScene as node, sceneHash as nodeHash } from "../../../packages/protocol/src/sampler.ts";
import { taskId } from "../../../packages/protocol/src/taskspec.ts";

let fails = 0;
const ok = (c, m, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };

/* A fixture rather than the published sample: the cross-implementation check
   is about the sampler, not about any one deployment, and it has to run in a
   repository that has nothing deployed yet. */
const spec = JSON.parse(readFileSync(new URL("../../../packages/protocol/test/fixture-task.json", import.meta.url), "utf8"));
const tid = taskId(spec);

let same = true, hashSame = true;
const seeds = [0n, 1n, 2n, 7n, 42n, 255n, 1000n, 65535n, 4294967295n, 18446744073709551615n];
for (const seed of seeds) {
  const a = browser(spec, tid, seed);
  const b = node(spec, tid, seed);
  if (JSON.stringify(a.objects) !== JSON.stringify(b.objects)) { same = false; console.log(`    objects differ at seed ${seed}`); }
  if (a.lightingIntensity !== b.lightingIntensity || a.lightingTemperatureK !== b.lightingTemperatureK) {
    same = false; console.log(`    lighting differs at seed ${seed}`);
  }
  if (browserHash(a) !== nodeHash(b)) { hashSame = false; console.log(`    scene hash differs at seed ${seed}`); }
}
ok(same, "the browser sampler places objects identically", `${seeds.length} seeds incl. 2^64-1`);
ok(hashSame, "and the scene hashes agree");

// 300 random seeds, because agreeing on the seeds you chose proves little.
let rnd = true;
for (let i = 0; i < 300; i++) {
  const seed = BigInt(Math.floor(Math.random() * 2 ** 48));
  if (browserHash(browser(spec, tid, seed)) !== nodeHash(node(spec, tid, seed))) { rnd = false; break; }
}
ok(rnd, "and on 300 random seeds");

// Determinism: the same seed twice must give the same world, or nothing is auditable.
ok(browserHash(browser(spec, tid, 9n)) === browserHash(browser(spec, tid, 9n)),
   "the same seed rebuilds the same world");
ok(browserHash(browser(spec, tid, 9n)) !== browserHash(browser(spec, tid, 10n)),
   "a different seed gives a different world");

// If this repository publishes a sample episode, its world must rebuild too.
// Where nothing is deployed there is no sample, and that is not a failure.
let epPath = null;
try { epPath = readFileSync(new URL("../sample-episode.json", import.meta.url), "utf8"); } catch {}
if (epPath) {
  const ep = JSON.parse(epPath);
  const pub = JSON.parse(readFileSync(new URL("../sample-task.json", import.meta.url), "utf8")).spec;
  const rebuilt = browser(pub, ep.taskId, BigInt(ep.worldSeed));
  ok(rebuilt.objects.length > 0, "the published episode's world rebuilds in the browser",
     `seed ${ep.worldSeed}, ${rebuilt.objects.length} objects`);
  ok(browserHash(rebuilt) === nodeHash(node(pub, ep.taskId, BigInt(ep.worldSeed))),
     "and matches the exporter for that episode");
} else {
  console.log("  --   no published episode in this repository, so nothing to rebuild");
}

console.log(fails === 0 ? "\nscene sampler: browser and exporter agree\n" : `\n${fails} check(s) failed\n`);
process.exit(fails ? 1 : 0);
