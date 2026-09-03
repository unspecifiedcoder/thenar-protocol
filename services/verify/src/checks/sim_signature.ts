/**
 * T-019 — L3 check `sim_signature.v1` (PLAN §10.9 check id `0x0005`).
 *
 * **FRONTIER gate FD-2 is open** (`TASKS/CONFLICTS.md`), and per
 * `TASKS/CONFLICTS.md`'s FD-2 note this check "stays indicative only in v2
 * (never blocks L3)" — permanently, not just until FD-2 closes. So, like
 * `sensor_consistency.v1` (`src/checks/sensor_consistency.ts`) and
 * `dedup.v1` (`src/checks/dedup.ts`, FD-1), a would-be `fail` is
 * unconditionally downgraded to `inconclusive` with
 * `detail.downgraded_from: "fail"`.
 *
 * Objective (TASK-019.md): does data declared `real` carry simulation
 * signatures? Four independent heuristic features (TASK-019.md "Rules",
 * fixed algorithm; per-feature trip thresholds not named by the task are
 * this implementation's documented choice — "implementation detail" class,
 * PLAN §10.9 — recorded in `check_version` and `detail.features`, not
 * `detail.thresholds`, which is reserved for the FD-2-gated `score_*`
 * pair):
 *
 *  1. **Exact-repeat fraction of state floats beyond quantisation.** Real
 *     sensor streams carry continuous per-frame noise; a bit-exact repeat
 *     of a joint's float value from one frame to the next is rare outside
 *     genuine mechanical stillness. Fraction of all `(frame, joint)`
 *     scalar deltas that are exactly `0`. Trips above `repeat_fraction_max`
 *     (0.05 — provisional implementation constant).
 *  2. **Zero Δt variance.** Real capture timing jitters at the microsecond
 *     level; a perfectly uniform `timestamp` grid (population variance of
 *     consecutive deltas below `dt_variance_epsilon`, 1e-12) is a
 *     simulator/replay signature.
 *  3. **Spectral power above 5 Hz.** The joint-speed-norm signal (same
 *     construction as `sensor_consistency.v1`'s `s(t)`, resampled here
 *     uniformly at 20 Hz so a 5 Hz cutoff sits well under Nyquist) is
 *     decomposed by a direct DFT; trips when the fraction of total power
 *     at frequencies > 5 Hz is below `spectral_power_max` (1e-6,
 *     TASK-019.md "Rules" — an exact figure, unlike the other three). Known
 *     limitation of this implementation (see "Known evasions" in
 *     `docs/VERIFICATION.md`): a rectangular-window DFT over a
 *     non-integer-cycle window leaks a non-negligible fraction of a
 *     genuinely sub-5Hz signal's power into higher bins, so in practice
 *     this feature trips reliably only for near-static or exactly
 *     window-periodic signals, not smooth arbitrary low-frequency motion —
 *     it is a weak signal on its own, redundant with the other three.
 *  4. **Zero frame-difference energy on >= 20% of frames.** From `motion`
 *     (`src/video/motion.ts`), the fraction of frames whose energy is
 *     exactly `0` (a perfectly static/no-noise render). Trips at
 *     `zero_motion_fraction_min` (0.20, TASK-019.md "Rules" — exact).
 *     Skipped (not counted toward `score`) when `motion === null`
 *     (TASK-019.md doesn't gate the whole check on video's absence the way
 *     `sensor_consistency.v1` does — only this one feature needs it).
 *
 * `score` = number of tripped features (of those evaluated).
 * `score_inconclusive` (prov. 2) / `score_fail` (prov. 3) — FD-2
 * configuration-class thresholds, recorded in `detail.thresholds`.
 * `source === "sim"` -> `pass` with `detail.note = "declared sim"`
 * (TASK-019.md "Rules") — a declared simulation is not being asked whether
 * it looks synthetic.
 */
import type { CheckOutcome } from "../types.ts";

export const CHECK_VERSION = "sim_signature.v1.0";

export type SimSignatureThresholds = { score_inconclusive: number; score_fail: number };

/** TASK-019.md "Rules": `score_inconclusive` (prov. 2), `score_fail` (prov. 3). */
export const DEFAULT_THRESHOLDS: SimSignatureThresholds = { score_inconclusive: 2, score_fail: 3 };

const REPEAT_FRACTION_MAX = 0.05;
const DT_VARIANCE_EPSILON = 1e-12;
const SPECTRAL_POWER_MAX = 1e-6;
const ZERO_MOTION_FRACTION_MIN = 0.2;
const SPECTRAL_CUTOFF_HZ = 5;
const SPECTRAL_RESAMPLE_HZ = 20;

export type SimSignatureSource = "real" | "sim" | "mixed";

type Feature = { name: string; value: number; tripped: boolean };

// -------------------------------------------------------- feature 1: exact repeats

function exactRepeatFraction(state: number[][]): number {
  if (state.length < 2) return 0;
  const dof = state[0].length;
  let repeats = 0;
  let total = 0;
  for (let i = 1; i < state.length; i++) {
    for (let j = 0; j < dof; j++) {
      total++;
      if (state[i][j] === state[i - 1][j]) repeats++;
    }
  }
  return total > 0 ? repeats / total : 0;
}

// -------------------------------------------------------- feature 2: dt variance

function dtVariance(ts: number[]): number {
  if (ts.length < 3) return Infinity; // too few samples to judge -> won't trip
  const deltas: number[] = [];
  for (let i = 1; i < ts.length; i++) deltas.push(ts[i] - ts[i - 1]);
  const mean = deltas.reduce((a, b) => a + b, 0) / deltas.length;
  const variance = deltas.reduce((a, d) => a + (d - mean) * (d - mean), 0) / deltas.length;
  return variance;
}

// ------------------------------------------------- feature 3: spectral power > 5Hz

function jointSpeedNorm(state: number[][], ts: number[]): { t: number; speed: number }[] {
  const out: { t: number; speed: number }[] = [];
  for (let i = 1; i < state.length; i++) {
    const dt = ts[i] - ts[i - 1];
    if (!(dt > 0)) continue;
    let sumSq = 0;
    const dof = state[i].length;
    for (let j = 0; j < dof; j++) {
      const d = state[i][j] - state[i - 1][j];
      sumSq += d * d;
    }
    out.push({ t: (ts[i] + ts[i - 1]) / 2, speed: Math.sqrt(sumSq) / dt });
  }
  return out;
}

function interpAt(points: { t: number; speed: number }[], t: number): number {
  if (points.length === 0) return 0;
  if (t <= points[0].t) return points[0].speed;
  if (t >= points[points.length - 1].t) return points[points.length - 1].speed;
  let lo = 0, hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid; else hi = mid;
  }
  const a = points[lo], b = points[hi];
  const frac = b.t > a.t ? (t - a.t) / (b.t - a.t) : 0;
  return a.speed + (b.speed - a.speed) * frac;
}

/** Fraction of total power at frequencies > `SPECTRAL_CUTOFF_HZ`, via a direct DFT of the uniformly-resampled joint-speed signal. */
function highFreqPowerFraction(state: number[][], ts: number[]): number | null {
  const speedPoints = jointSpeedNorm(state, ts);
  if (speedPoints.length < 2) return null;

  const t0 = ts[0];
  const duration = ts[ts.length - 1] - ts[0];
  const dt = 1 / SPECTRAL_RESAMPLE_HZ;
  const n = Math.floor(duration / dt) + 1;
  if (n < 4) return null; // too short to say anything about spectral content

  const signal = new Array<number>(n);
  for (let k = 0; k < n; k++) signal[k] = interpAt(speedPoints, t0 + k * dt);

  const mean = signal.reduce((a, b) => a + b, 0) / n;
  const centered = signal.map((v) => v - mean);

  let totalPower = 0;
  let highPower = 0;
  const half = Math.floor(n / 2);
  for (let k = 0; k <= half; k++) {
    let re = 0, im = 0;
    for (let x = 0; x < n; x++) {
      const angle = (-2 * Math.PI * k * x) / n;
      re += centered[x] * Math.cos(angle);
      im += centered[x] * Math.sin(angle);
    }
    const power = re * re + im * im;
    const freq = (k * SPECTRAL_RESAMPLE_HZ) / n;
    totalPower += power;
    if (freq > SPECTRAL_CUTOFF_HZ) highPower += power;
  }
  return totalPower > 0 ? highPower / totalPower : 0;
}

// ---------------------------------------------------------- feature 4: motion zeros

function zeroMotionFraction(motion: number[]): number {
  if (motion.length === 0) return 0;
  const zeros = motion.filter((v) => v === 0).length;
  return zeros / motion.length;
}

// --------------------------------------------------------------------- check

export function simSignatureCheck(
  frames: { timestamp: number[]; state: number[][] },
  motion: number[] | null,
  source: SimSignatureSource,
  thresholds: SimSignatureThresholds = DEFAULT_THRESHOLDS,
): CheckOutcome {
  const detailBase = { check_version: CHECK_VERSION, thresholds };

  if (source === "sim") {
    return { result: "pass", level: 3, detail: { ...detailBase, note: "declared sim" } };
  }

  const { timestamp: ts, state } = frames;
  if (!ts || !state || ts.length === 0 || state.length === 0 || ts.length !== state.length) {
    return { result: "inconclusive", level: 3, detail: { ...detailBase, reason: "no frames" } };
  }

  const features: Feature[] = [];

  const repeatFraction = exactRepeatFraction(state);
  features.push({
    name: "exact_repeat_fraction",
    value: repeatFraction,
    tripped: repeatFraction > REPEAT_FRACTION_MAX,
  });

  const variance = dtVariance(ts);
  features.push({
    name: "dt_variance",
    value: variance,
    tripped: variance < DT_VARIANCE_EPSILON,
  });

  const highFreqFraction = highFreqPowerFraction(state, ts);
  if (highFreqFraction !== null) {
    features.push({
      name: "spectral_power_gt_5hz_fraction",
      value: highFreqFraction,
      tripped: highFreqFraction < SPECTRAL_POWER_MAX,
    });
  }

  if (motion !== null) {
    const zeroFraction = zeroMotionFraction(motion);
    features.push({
      name: "zero_frame_diff_fraction",
      value: zeroFraction,
      tripped: zeroFraction >= ZERO_MOTION_FRACTION_MIN,
    });
  }

  const score = features.filter((f) => f.tripped).length;
  const detail = {
    ...detailBase,
    score,
    features: features as unknown as Record<string, unknown>[],
  };

  if (score >= thresholds.score_fail) {
    return { result: "inconclusive", level: 3, detail: { ...detail, downgraded_from: "fail" } };
  }
  if (score >= thresholds.score_inconclusive) {
    return { result: "inconclusive", level: 3, detail };
  }
  return { result: "pass", level: 3, detail };
}
