/**
 * T-019 — L3 check `sensor_consistency.v1` (PLAN §10.9 check id `0x0004`).
 *
 * **FRONTIER gate FD-2 is open** (`TASKS/CONFLICTS.md`): thresholds are
 * provisional and this check must never emit `fail`. `config/checks.json`
 * pins `sensor_consistency.v1.blocking: false, emit_fail: false`, and a
 * would-be `fail` (`rho < rho_fail`) is downgraded to `inconclusive` with
 * `detail.downgraded_from: "fail"` — mirroring `dedup.v1`'s FD-1 downgrade
 * (`src/checks/dedup.ts`), applied here unconditionally in code (not
 * threaded through `config/checks.json`'s `emit_fail`, since this check has
 * no config-reading caller yet — T-020 does not exist, see this task's
 * supervisor adjustment note in `src/types.ts`).
 *
 * Objective (TASK-019.md): does video motion correlate with proprioceptive
 * motion? A real episode's joint speed and its camera's frame-difference
 * motion energy should move together; a mismatch (arm moving with a static
 * camera feed, or vice versa) is evidence of a mislabeled or synthetic
 * recording.
 *
 * Algorithm (TASK-019.md "Rules", fixed; deviations from the task's
 * one-line sketch documented below):
 *  1. `s(t)` = joint-speed norm at 5 Hz: finite-difference velocity of
 *     `observation.state` at the episode's own (irregular) timestamps,
 *     L2-normed across joints, then linearly resampled onto the same 5 Hz
 *     grid `motion` is sampled on (`t0 + k/5`, `k = 0..motion.length-1`,
 *     `t0 = frames.timestamp[0]` — the window `motion` was computed over is
 *     `ref.range.video[camera]`, whose start is what `src/run.ts` passes as
 *     `t0` to the motion provider; frames are already restricted to that
 *     episode, so its own first timestamp is the matching origin).
 *  2. `m(t)` = motion energy, passed in directly (already 5 Hz, `src/video/motion.ts`).
 *  3. Pearson `ρ` between the two resampled series.
 *  4. `ρ >= rho_pass` -> `pass`; `ρ < rho_fail` -> `fail` (downgraded per
 *     FD-2); otherwise `inconclusive`.
 *  5. No video (`motion === null`) -> `inconclusive` (TASK-019.md Rules).
 */
import type { CheckOutcome } from "../types.ts";

export const CHECK_VERSION = "sensor_consistency.v1.0";

export type SensorConsistencyThresholds = { rho_pass: number; rho_fail: number };

/** TASK-019.md "Rules": `ρ_pass` (prov. 0.4), `ρ_fail` (prov. 0.2). */
export const DEFAULT_THRESHOLDS: SensorConsistencyThresholds = { rho_pass: 0.4, rho_fail: 0.2 };

function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  let sumA = 0, sumB = 0;
  for (let i = 0; i < n; i++) { sumA += a[i]; sumB += b[i]; }
  const meanA = sumA / n, meanB = sumB / n;
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - meanA, db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA <= 0 || varB <= 0) return null; // degenerate: at least one series is constant
  return cov / Math.sqrt(varA * varB);
}

/** Joint-speed norm per raw frame gap `i` (`i = 1..N-1`), assigned to the midpoint time `(ts[i]+ts[i-1])/2`. */
function rawSpeed(state: number[][], ts: number[]): { t: number; speed: number }[] {
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

/** Linear interpolation of `points` (sorted by `t`) at `t`, clamped to the series' boundary values outside its span. */
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

export function sensorConsistencyCheck(
  frames: { timestamp: number[]; state: number[][] },
  motion: number[] | null,
  thresholds: SensorConsistencyThresholds = DEFAULT_THRESHOLDS,
): CheckOutcome {
  const detailBase = { check_version: CHECK_VERSION, thresholds };

  if (motion === null) {
    return { result: "inconclusive", level: 3, detail: { ...detailBase, reason: "no video" } };
  }
  const { timestamp: ts, state } = frames;
  if (!ts || !state || ts.length === 0 || state.length === 0 || ts.length !== state.length) {
    return { result: "inconclusive", level: 3, detail: { ...detailBase, reason: "no frames" } };
  }
  if (motion.length < 2) {
    return { result: "inconclusive", level: 3, detail: { ...detailBase, reason: "insufficient motion samples" } };
  }

  const speedPoints = rawSpeed(state, ts);
  if (speedPoints.length === 0) {
    return { result: "inconclusive", level: 3, detail: { ...detailBase, reason: "no valid speed samples" } };
  }

  const t0 = ts[0];
  const s: number[] = [];
  for (let k = 0; k < motion.length; k++) {
    s.push(interpAt(speedPoints, t0 + k / 5));
  }

  const rho = pearson(s, motion);
  const samples = Math.min(s.length, motion.length);

  if (rho === null) {
    return {
      result: "inconclusive",
      level: 3,
      detail: { ...detailBase, reason: "degenerate variance", samples },
    };
  }

  const detail = { ...detailBase, rho, samples };

  if (rho >= thresholds.rho_pass) {
    return { result: "pass", level: 3, detail };
  }
  if (rho < thresholds.rho_fail) {
    return { result: "inconclusive", level: 3, detail: { ...detail, downgraded_from: "fail" } };
  }
  return { result: "inconclusive", level: 3, detail };
}
