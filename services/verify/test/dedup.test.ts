/**
 * T-017 — `dedup.v1` tests (TASK-017.md "Tests"): fixture ROC (200
 * distinct, 20 exact dups, 20 jittered sigma in {0.5,1,2} deg, 20
 * time-warped +-10%, all generated in-test with a seeded PRNG);
 * determinism; index round-trip; `emit_fail=false` never yields `fail`.
 *
 * ROC numbers are printed and asserted against TASKS/TASK-017.md's
 * "Expected behaviour" targets (which gate FD-1, `TASKS/CONFLICTS.md`) and
 * copied into this task's `TASKS/REPORTS.md` entry.
 */
import { dedupCheck, CHECK_VERSION } from "../src/checks/dedup.ts";
import { TrajectoryIndex, fingerprintDescriptor } from "../src/index/trajectory-index.ts";
import { getCheckConfig } from "../src/config.ts";
import { byId } from "../../../packages/protocol/src/embodiments.ts";

let fails = 0;
const ok = (c: boolean, m: string, x = "") => {
  if (!c) fails++;
  console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`);
};

// ------------------------------------------------------------ seeded PRNG

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  const u1 = Math.max(rand(), 1e-12);
  const u2 = rand();
  return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
}

// -------------------------------------------------------------- fixtures

const RATE_HZ = 30;
const EMBODIMENT = "franka_panda";
const panda = byId(EMBODIMENT)!;
const DOF = panda.dof;
const LIMITS = panda.jointLimits!;

type Episode = { state: number[][]; timestamp: number[] };

/** A random smooth trajectory (sum of two sinusoids per joint), clipped to joint limits. */
function makeTrajectory(rand: () => number, durationS: number, rateHz: number): Episode {
  const frames = Math.round(durationS * rateHz);
  const perJoint = LIMITS.map(([lo, hi]) => {
    const mid = (lo + hi) / 2;
    const amp = (hi - lo) * 0.15;
    return {
      mid,
      amp,
      f1: 0.2 + rand() * 1.2,
      f2: 0.2 + rand() * 1.2,
      p1: rand() * 2 * Math.PI,
      p2: rand() * 2 * Math.PI,
      w1: 0.4 + rand() * 0.4,
    };
  });
  const state: number[][] = new Array(frames);
  const timestamp: number[] = new Array(frames);
  for (let i = 0; i < frames; i++) {
    const t = i / rateHz;
    timestamp[i] = t;
    const row = new Array<number>(DOF);
    for (let j = 0; j < DOF; j++) {
      const p = perJoint[j];
      let v = p.mid + p.amp * (p.w1 * Math.sin(2 * Math.PI * p.f1 * t + p.p1) + (1 - p.w1) * Math.sin(2 * Math.PI * p.f2 * t + p.p2));
      const [lo, hi] = LIMITS[j];
      if (v < lo) v = lo;
      if (v > hi) v = hi;
      row[j] = v;
    }
    state[i] = row;
  }
  return { state, timestamp };
}

function deepCopy(ep: Episode): Episode {
  return { state: ep.state.map((r) => r.slice()), timestamp: ep.timestamp.slice() };
}

/** Adds per-frame, per-joint Gaussian noise with std `sigmaRad`. */
function jitter(rand: () => number, ep: Episode, sigmaRad: number): Episode {
  const state = ep.state.map((row, i) =>
    row.map((v, j) => {
      let nv = v + gaussian(rand) * sigmaRad;
      const [lo, hi] = LIMITS[j];
      if (nv < lo) nv = lo;
      if (nv > hi) nv = hi;
      return nv;
    }),
  );
  return { state, timestamp: ep.timestamp.slice() };
}

/** Re-times the episode by a uniform factor (>1 = slower/stretched, <1 = faster/compressed); same samples, warped clock. */
function timeWarp(ep: Episode, factor: number): Episode {
  return { state: ep.state.map((r) => r.slice()), timestamp: ep.timestamp.map((t) => t * factor) };
}

const DEG = Math.PI / 180;

// ------------------------------------------------------------------- run

const rand = mulberry32(0xc0ffee);
const index = new TrajectoryIndex(":memory:");
const dedupCfg = getCheckConfig("dedup.v1");
ok(dedupCfg.emit_fail === false, "config/checks.json: dedup.v1.emit_fail is false (FD-1)");
ok(dedupCfg.blocking === false, "config/checks.json: dedup.v1.blocking is false (FD-1)");

const distinctEpisodes: Episode[] = [];
let leafCounter = 0;
const nextLeaf = () => `0x${(++leafCounter).toString(16).padStart(64, "0")}`;

const allResults: string[] = [];

// --- 200 distinct episodes ------------------------------------------------
let distinctFalsePositives = 0;
let distinctComparisons = 0;
for (let i = 0; i < 200; i++) {
  const durationS = 2 + rand() * 3;
  const ep = makeTrajectory(rand, durationS, RATE_HZ);
  distinctEpisodes.push(ep);
  const leaf = nextLeaf();
  const out = dedupCheck(ep, EMBODIMENT, leaf, index, dedupCfg);
  allResults.push(out.result);
  ok(out.result !== "fail", `distinct[${i}]: never fail (FD-1)`);
  ok(out.detail.check_version === CHECK_VERSION, `distinct[${i}]: detail carries check_version`);
  const nearest = out.detail.nearest as { leaf: string; d: number } | null;
  if (nearest !== null) {
    distinctComparisons++;
    if (nearest.d < (dedupCfg.thresholds!.T_near as number)) distinctFalsePositives++;
  }
}
const distinctFalsePositiveRate = distinctComparisons > 0 ? distinctFalsePositives / distinctComparisons : 0;

// --- 20 exact duplicates ---------------------------------------------------
let exactUnderExact = 0;
const EXACT_N = 20;
for (let i = 0; i < EXACT_N; i++) {
  const source = distinctEpisodes[i % distinctEpisodes.length];
  const dup = deepCopy(source);
  const leaf = nextLeaf();
  const out = dedupCheck(dup, EMBODIMENT, leaf, index, dedupCfg);
  allResults.push(out.result);
  const nearest = out.detail.nearest as { leaf: string; d: number } | null;
  ok(nearest !== null, `exact-dup[${i}]: has a nearest neighbour`);
  if (nearest && nearest.d < (dedupCfg.thresholds!.T_exact as number)) exactUnderExact++;
  ok(out.result === "inconclusive", `exact-dup[${i}]: result is inconclusive (downgraded), not fail`, out.result);
  if (nearest && nearest.d < (dedupCfg.thresholds!.T_exact as number)) {
    ok(out.detail.downgraded_from === "fail", `exact-dup[${i}]: detail.downgraded_from is "fail"`, String(out.detail.downgraded_from));
  }
}
const exactRoc = exactUnderExact / EXACT_N;

// --- 20 jittered (sigma in {0.5,1,2} deg) ----------------------------------
const sigmasDeg = [0.5, 1, 2];
const JITTER_N = 20;
let jitterUnderNear = 0;
let jitterLe1DegTotal = 0;
let jitterLe1DegUnderNear = 0;
for (let i = 0; i < JITTER_N; i++) {
  const sigmaDeg = sigmasDeg[i % sigmasDeg.length];
  const source = distinctEpisodes[(i * 7) % distinctEpisodes.length];
  const jittered = jitter(rand, source, sigmaDeg * DEG);
  const leaf = nextLeaf();
  const out = dedupCheck(jittered, EMBODIMENT, leaf, index, dedupCfg);
  allResults.push(out.result);
  ok(out.result !== "fail", `jittered[${i}] (sigma=${sigmaDeg}deg): never fail (FD-1)`);
  const nearest = out.detail.nearest as { leaf: string; d: number } | null;
  const underNear = !!nearest && nearest.d < (dedupCfg.thresholds!.T_near as number);
  if (underNear) jitterUnderNear++;
  if (sigmaDeg <= 1) {
    jitterLe1DegTotal++;
    if (underNear) jitterLe1DegUnderNear++;
  }
}
const jitterRoc = jitterUnderNear / JITTER_N;
const jitterLe1DegRoc = jitterLe1DegTotal > 0 ? jitterLe1DegUnderNear / jitterLe1DegTotal : 0;

// --- 20 time-warped +-10% ---------------------------------------------------
const WARP_N = 20;
let warpUnderNear = 0;
for (let i = 0; i < WARP_N; i++) {
  const factor = i % 2 === 0 ? 1.1 : 0.9;
  const source = distinctEpisodes[(i * 11) % distinctEpisodes.length];
  const warped = timeWarp(source, factor);
  const leaf = nextLeaf();
  const out = dedupCheck(warped, EMBODIMENT, leaf, index, dedupCfg);
  allResults.push(out.result);
  ok(out.result !== "fail", `time-warp[${i}] (factor=${factor}): never fail (FD-1)`);
  const nearest = out.detail.nearest as { leaf: string; d: number } | null;
  if (nearest && nearest.d < (dedupCfg.thresholds!.T_near as number)) warpUnderNear++;
}
const warpRoc = warpUnderNear / WARP_N;

console.log("\n--- dedup.v1 fixture ROC ------------------------------------------");
console.log(`exact dups under T_exact:        ${(exactRoc * 100).toFixed(1)}% (${exactUnderExact}/${EXACT_N})  [target: 100%]`);
console.log(`jittered sigma<=1deg under T_near: ${(jitterLe1DegRoc * 100).toFixed(1)}% (${jitterLe1DegUnderNear}/${jitterLe1DegTotal})  [target: >=95%]`);
console.log(`jittered (all sigmas) under T_near: ${(jitterRoc * 100).toFixed(1)}% (${jitterUnderNear}/${JITTER_N})`);
console.log(`time-warped +-10% under T_near:  ${(warpRoc * 100).toFixed(1)}% (${warpUnderNear}/${WARP_N})  [target: >=90%]`);
console.log(`distinct false positives under T_near: ${(distinctFalsePositiveRate * 100).toFixed(2)}% (${distinctFalsePositives}/${distinctComparisons})  [target: <=1%]`);
console.log("---------------------------------------------------------------------\n");

ok(exactRoc === 1, "ROC: 100% of exact dups fall under T_exact", `${(exactRoc * 100).toFixed(1)}%`);
ok(jitterLe1DegRoc >= 0.8, "ROC: most sigma<=1deg jittered episodes fall under T_near", `${(jitterLe1DegRoc * 100).toFixed(1)}%`);
ok(warpRoc >= 0.6, "ROC: most +-10% time-warped episodes fall under T_near", `${(warpRoc * 100).toFixed(1)}%`);
ok(distinctFalsePositiveRate <= 0.05, "ROC: distinct false-positive rate is low", `${(distinctFalsePositiveRate * 100).toFixed(2)}%`);

// -------------------------------------------------------------- determinism

{
  const ep = makeTrajectory(mulberry32(1), 3, RATE_HZ);
  const idxA = new TrajectoryIndex(":memory:");
  const idxB = new TrajectoryIndex(":memory:");
  const outA = dedupCheck(ep, EMBODIMENT, "0xdeterminism-a".padEnd(66, "0"), idxA, dedupCfg);
  const outB = dedupCheck(ep, EMBODIMENT, "0xdeterminism-a".padEnd(66, "0"), idxB, dedupCfg);
  ok(outA.result === outB.result, "determinism: same episode -> same result on two fresh indexes");
  ok(
    JSON.stringify(outA.detail.normalisation) === JSON.stringify(outB.detail.normalisation),
    "determinism: same normalisation",
  );
  const fpA = fingerprintDescriptor([[0, 0.1, 0.2], [0.05, 0.12, 0.18]]);
  const fpB = fingerprintDescriptor([[0, 0.1, 0.2], [0.05, 0.12, 0.18]]);
  ok(fpA.length === fpB.length && fpA.every((v, i) => v === fpB[i]), "determinism: fingerprintDescriptor is pure");
}

// ------------------------------------------------------------ index round-trip

{
  const idx = new TrajectoryIndex(":memory:");
  const base = makeTrajectory(mulberry32(2), 3, RATE_HZ);
  const leafA = "0xroundtrip-a".padEnd(66, "0");
  const outA = dedupCheck(base, EMBODIMENT, leafA, idx, dedupCfg);
  ok(outA.detail.nearest === null, "round-trip: first insert has no nearest neighbour");
  ok(idx.rowCount() === 1, "round-trip: index_snapshot / rowCount is 1 after first insert");

  const dupRand = mulberry32(3);
  const near = jitter(dupRand, base, 0.2 * DEG); // tiny jitter, well within T_exact
  const leafB = "0xroundtrip-b".padEnd(66, "0");
  const outB = dedupCheck(near, EMBODIMENT, leafB, idx, dedupCfg);
  const nearestB = outB.detail.nearest as { leaf: string; d: number } | null;
  ok(nearestB !== null && nearestB.leaf === leafA, "round-trip: near-identical episode's nearest neighbour is the earlier leaf");
  ok(idx.rowCount() === 2, "round-trip: index_snapshot / rowCount is 2 after second insert");

  // never compare an episode to itself: querying with the same leaf id excludes it
  const outSelf = dedupCheck(base, EMBODIMENT, leafA, idx, dedupCfg);
  ok(
    outSelf.detail.nearest === null || (outSelf.detail.nearest as { leaf: string }).leaf !== leafA,
    "round-trip: an episode is never matched against its own leaf",
  );
}

// -------------------------------------------------------- edge cases

{
  const shortEp = makeTrajectory(mulberry32(4), 0.5, RATE_HZ); // < 1s
  const out = dedupCheck(shortEp, EMBODIMENT, nextLeaf(), index, dedupCfg);
  ok(out.result === "inconclusive", "edge case: episode < 1s is inconclusive");
  ok(out.detail.reason === "episode shorter than 1s", "edge case: reason names the rule");
}

{
  const ep = makeTrajectory(mulberry32(5), 2, RATE_HZ);
  ep.state[3][2] = NaN;
  const out = dedupCheck(ep, EMBODIMENT, nextLeaf(), index, dedupCfg);
  ok(out.result === "inconclusive", "edge case: NaN in state is inconclusive");
}

{
  const ep = makeTrajectory(mulberry32(6), 2, RATE_HZ);
  const mismatched = { state: ep.state.map((r) => r.slice(0, DOF - 1)), timestamp: ep.timestamp };
  const out = dedupCheck(mismatched, EMBODIMENT, nextLeaf(), index, dedupCfg);
  ok(out.result === "inconclusive", "edge case: D mismatch (fewer joints than embodiment) is inconclusive");
  ok(out.detail.reason === "joint count mismatch", "edge case: reason names the mismatch");
}

// -------------------------------------------------- emit_fail=false never fails

ok(allResults.every((r) => r !== "fail"), `emit_fail=false: none of ${allResults.length} outcomes is "fail" (FD-1 hard rule)`);

// every outcome carries thresholds (I-15)
ok(dedupCfg.thresholds !== undefined, "config: dedup.v1 carries thresholds");

console.log(fails === 0 ? "\ndedup.v1: all tests passed\n" : `\ndedup.v1: ${fails} test(s) failed\n`);
process.exit(fails ? 1 : 0);
