/**
 * T-019 — `sim_signature.v1` unit tests (TASK-019.md "Tests"): sim-like
 * (noise-free, quantised, zero Δt variance) vs real-like trajectories,
 * declared-sim pass, downgrade path (FD-2 — never emits `fail`, and stays
 * indicative regardless of FD-2's status per `TASKS/CONFLICTS.md`).
 */
import { simSignatureCheck, CHECK_VERSION, DEFAULT_THRESHOLDS } from "../src/checks/sim_signature.ts";

let fails = 0;
const ok = (c: boolean, m: string, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };

const RATE = 30;
const DOF = 6;
const N = 300; // 10s at 30Hz

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

/**
 * A "real-like" trajectory: smooth multi-sinusoid joint motion (broadband,
 * so it carries genuine content above 5 Hz once summed) with small
 * per-frame float noise and jittered timestamps — none of the four
 * sim-signature features should trip.
 */
function realLikeEpisode(rand: () => number): { timestamp: number[]; state: number[][] } {
  const timestamp: number[] = [];
  let t = 0;
  for (let i = 0; i < N; i++) {
    t += 1 / RATE + (rand() - 0.5) * 0.0015; // sub-ms jitter, real capture timing
    timestamp.push(t);
  }
  const state = timestamp.map((tt) =>
    Array.from({ length: DOF }, (_, j) => {
      const base =
        Math.sin(2 * Math.PI * (0.4 + 0.15 * j) * tt) +
        0.3 * Math.sin(2 * Math.PI * (6 + j) * tt); // broadband content above 5Hz
      return base + (rand() - 0.5) * 1e-4; // continuous sensor noise: no exact repeats
    }),
  );
  return { timestamp, state };
}

/**
 * A "sim-like" trajectory: perfectly uniform timestamps (feature 2) and
 * quantised, frequently-repeating joint values (feature 1), paired below
 * with all-zero motion (feature 4) — enough to clear `score_fail` (3) on
 * its own. (Value quantisation adds step-edge harmonics of its own, so
 * this particular fixture does not also trip the >5 Hz spectral-power
 * feature — the four features are independent artifacts, not all expected
 * to co-occur in every synthetic example.)
 */
function simLikeEpisode(): { timestamp: number[]; state: number[][] } {
  const timestamp = Array.from({ length: N }, (_, i) => i / RATE); // zero Δt variance
  const quantum = 0.01;
  const state = timestamp.map((t) =>
    Array.from({ length: DOF }, (_, j) => {
      const raw = 0.5 * Math.sin(2 * Math.PI * 0.2 * t + j); // single low frequency, well under 5Hz
      return Math.round(raw / quantum) * quantum; // quantised -> frequent exact repeats
    }),
  );
  return { timestamp, state };
}

const zeroMotion = new Array(50).fill(0); // motion energy is zero every frame
const noisyMotion = Array.from({ length: 50 }, (_, i) => 10 + 5 * Math.abs(Math.sin(i))); // never zero

// --- real-like data, real-like motion -> pass -----------------------------
{
  const { timestamp, state } = realLikeEpisode(mulberry32(1));
  const out = simSignatureCheck({ timestamp, state }, noisyMotion, "real");
  ok(out.result === "pass", "real-like trajectory passes", JSON.stringify(out.detail));
  ok(out.level === 3, "level is 3");
  ok(out.detail.check_version === CHECK_VERSION, "detail carries check_version");
  ok(JSON.stringify(out.detail.thresholds) === JSON.stringify(DEFAULT_THRESHOLDS), "detail carries thresholds");
  ok((out.detail.score as number) < DEFAULT_THRESHOLDS.score_inconclusive, "score below score_inconclusive");
}

// --- sim-like data, declared "real" -> all 4 features trip, downgraded fail
{
  const { timestamp, state } = simLikeEpisode();
  const out = simSignatureCheck({ timestamp, state }, zeroMotion, "real");
  ok(out.result === "inconclusive", "sim-like trajectory declared real is never fail (FD-2)", JSON.stringify(out.detail));
  ok(out.detail.downgraded_from === "fail", "would-be fail is downgraded and recorded");
  ok((out.detail.score as number) >= DEFAULT_THRESHOLDS.score_fail, "score at/above score_fail");
  const features = out.detail.features as { name: string; tripped: boolean }[];
  ok(features.length === 4, "all four features were evaluated (motion present)");
  ok(features.filter((f) => f.tripped).length >= DEFAULT_THRESHOLDS.score_fail,
    "at least score_fail features tripped", JSON.stringify(features));
  const byName = Object.fromEntries(features.map((f) => [f.name, f.tripped]));
  ok(byName.exact_repeat_fraction === true, "quantised values trip the exact-repeat feature");
  ok(byName.dt_variance === true, "uniform timestamps trip the zero-Δt-variance feature");
  ok(byName.zero_frame_diff_fraction === true, "all-zero motion trips the frame-difference feature");
}

// --- declared sim -> pass regardless of signature, with a note -----------
{
  const { timestamp, state } = simLikeEpisode();
  const out = simSignatureCheck({ timestamp, state }, zeroMotion, "sim");
  ok(out.result === "pass", "declared sim passes unconditionally");
  ok(out.detail.note === "declared sim", "detail carries the declared-sim note");
}

// --- no video: feature 4 is skipped, not counted, no crash ---------------
{
  const { timestamp, state } = realLikeEpisode(mulberry32(2));
  const out = simSignatureCheck({ timestamp, state }, null, "real");
  const features = out.detail.features as { name: string }[];
  ok(features.length === 3, "feature 4 (frame-diff) is skipped when there's no video", String(features.length));
  ok(out.result !== "fail", "never fail");
}

// --- mixed source is treated like real (not given a free pass) -----------
{
  const { timestamp, state } = simLikeEpisode();
  const out = simSignatureCheck({ timestamp, state }, zeroMotion, "mixed");
  ok(out.result === "inconclusive", "mixed source with sim-like data is inconclusive, not a free pass");
  ok(out.detail.downgraded_from === "fail", "mixed source's would-be fail is also downgraded");
}

// --- empty frames -> inconclusive -----------------------------------------
{
  const out = simSignatureCheck({ timestamp: [], state: [] }, null, "real");
  ok(out.result === "inconclusive", "empty frames are inconclusive");
  ok(out.detail.reason === "no frames", "reason names the cause");
}

console.log(fails === 0 ? "\nsim_signature.v1: all tests passed\n" : `\nsim_signature.v1: ${fails} test(s) failed\n`);
process.exit(fails ? 1 : 0);
