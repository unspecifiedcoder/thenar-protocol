/**
 * T-017 — L3 check `dedup.v1` (PLAN.md Sec10.9 check id 0x0001).
 *
 * **FRONTIER gate FD-1 is open** (`TASKS/CONFLICTS.md`): this check must
 * never emit `fail`. `config/checks.json` pins `dedup.v1.emit_fail: false`,
 * and a would-be `fail` (`d < T_exact`) is downgraded to `inconclusive`
 * with `detail.downgraded_from: "fail"` — the `emit_fail` flag is still
 * honoured in code (T-020's future worker reads the same config), it is
 * just always `false` for this check until FD-1 closes.
 *
 * Algorithm (TASK-017.md, fixed; deviations documented where the task's
 * one-line schema sketch left something underspecified — see
 * `../index/schema.sql` for why `f` stores the full trajectory):
 *  1. Load `observation.state` (N x D); resample to 10 Hz (linear);
 *     normalise per joint by embodiment joint range when known, else
 *     per-episode min/max (`detail.normalisation`).
 *  2/3. Candidates: cosine-LSH over the resampled trajectory's descriptor
 *     -> <= 50, restricted to the same embodiment (`TrajectoryIndex`).
 *  4. `d = DTW_band10%(a, b) / (len_a + len_b)`, banded DTW between this
 *     episode's resampled trajectory and each candidate's.
 *  5. `d < T_exact` -> `fail` (downgraded per FD-1); `T_exact <= d <
 *     T_near` -> `inconclusive`; else `pass`.
 *  6. Insert after deciding.
 */
import { byId } from "../../../../packages/protocol/src/embodiments.ts";
import type { JsonObject } from "../../../../packages/protocol/src/canonical.ts";
import type { CheckOutcome, CheckResult } from "../types.ts";
import type { CheckConfig } from "../config.ts";
import { TrajectoryIndex } from "../index/trajectory-index.ts";

export const CHECK_VERSION = "dedup.v1.0";

const TARGET_HZ = 10;
const MIN_DURATION_S = 1;
const DTW_BAND_FRACTION = 0.1;

export type DedupFrames = { state: number[][]; timestamp: number[] };

// ------------------------------------------------------------- normalisation

function normaliseState(
  state: number[][],
  jointLimits: [number, number][] | undefined,
): { normalized: number[][]; normalisation: JsonObject } {
  const dof = state[0].length;
  let ranges: [number, number][];
  let method: string;

  if (jointLimits && jointLimits.length === dof) {
    ranges = jointLimits;
    method = "embodiment_limits";
  } else {
    ranges = [];
    for (let j = 0; j < dof; j++) {
      let lo = Infinity, hi = -Infinity;
      for (const row of state) {
        const v = row[j];
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
      if (!(lo < hi)) { lo -= 0.5; hi += 0.5; } // constant column: give it a non-degenerate span
      ranges.push([lo, hi]);
    }
    method = "episode_minmax";
  }

  const normalized = state.map((row) =>
    row.map((v, j) => {
      const [lo, hi] = ranges[j];
      const span = hi - lo || 1;
      const n = (v - lo) / span;
      return n < 0 ? 0 : n > 1 ? 1 : n;
    }),
  );

  return { normalized, normalisation: { method, ranges: ranges as unknown as JsonObject } };
}

// ------------------------------------------------------------------ resample

/** Linear resample onto a fixed 10 Hz grid spanning `[ts[0], ts[last]]` (TASK-017.md step 1). */
function resampleLinear(state: number[][], ts: number[], targetHz: number): number[][] {
  const t0 = ts[0];
  const t1 = ts[ts.length - 1];
  const duration = t1 - t0;
  const dt = 1 / targetHz;
  const nSamples = Math.floor(duration / dt) + 1;
  const dof = state[0].length;
  const lastIdx = ts.length - 1;

  const out: number[][] = new Array(nSamples);
  let idx = 0;
  for (let k = 0; k < nSamples; k++) {
    const t = t0 + k * dt;
    while (idx < lastIdx - 1 && ts[idx + 1] < t) idx++;
    const iA = idx;
    const iB = Math.min(idx + 1, lastIdx);
    const tA = ts[iA], tB = ts[iB];
    const frac = tB > tA ? (t - tA) / (tB - tA) : 0;
    const row = new Array<number>(dof);
    for (let j = 0; j < dof; j++) {
      const a = state[iA][j], b = state[iB][j];
      row[j] = a + (b - a) * frac;
    }
    out[k] = row;
  }
  return out;
}

// ---------------------------------------------------------------------- DTW

function euclid(u: number[], v: number[]): number {
  let s = 0;
  for (let i = 0; i < u.length; i++) {
    const d = u[i] - v[i];
    s += d * d;
  }
  return Math.sqrt(s);
}

/** Sakoe-Chiba banded DTW; band width is `max(bandFraction * max(n,m), |n-m|)` so `(n,m)` stays reachable. */
function bandedDtw(a: number[][], b: number[][], bandFraction: number): number {
  const n = a.length, m = b.length;
  const band = Math.max(1, Math.ceil(bandFraction * Math.max(n, m)), Math.abs(n - m));
  const INF = Infinity;

  let prev = new Float64Array(m + 1).fill(INF);
  let curr = new Float64Array(m + 1).fill(INF);
  prev[0] = 0;

  for (let i = 1; i <= n; i++) {
    curr.fill(INF);
    const jStart = Math.max(1, i - band);
    const jEnd = Math.min(m, i + band);
    for (let j = jStart; j <= jEnd; j++) {
      const cost = euclid(a[i - 1], b[j - 1]);
      const diag = prev[j - 1];
      const up = prev[j];
      const left = curr[j - 1];
      curr[j] = cost + Math.min(diag, up, left);
    }
    const tmp = prev;
    prev = curr;
    curr = tmp;
  }
  return prev[m];
}

// --------------------------------------------------------------------- check

function inc(detailBase: JsonObject, extra: JsonObject): CheckOutcome {
  return { result: "inconclusive", level: 3, detail: { ...detailBase, ...extra } };
}

export function dedupCheck(
  frames: DedupFrames,
  embodimentId: string,
  leaf: string,
  index: TrajectoryIndex,
  config: CheckConfig,
): CheckOutcome {
  const thresholds = {
    T_exact: (config.thresholds?.T_exact as number) ?? 0.02,
    T_near: (config.thresholds?.T_near as number) ?? 0.05,
  };
  const detailBase: JsonObject & { check_version: string; thresholds: JsonObject } = {
    check_version: CHECK_VERSION,
    thresholds,
  };

  const { state, timestamp: ts } = frames;

  if (!state || state.length === 0 || !ts || ts.length === 0) {
    return inc(detailBase, { reason: "no frames" });
  }
  if (state.length !== ts.length) {
    return inc(detailBase, { reason: "state/timestamp length mismatch" });
  }
  const dof = state[0].length;
  for (const row of state) {
    if (row.length !== dof) return inc(detailBase, { reason: "ragged state rows" });
    for (const v of row) if (!Number.isFinite(v)) return inc(detailBase, { reason: "non-finite value in state" });
  }
  for (const t of ts) if (!Number.isFinite(t)) return inc(detailBase, { reason: "non-finite timestamp" });
  for (let i = 1; i < ts.length; i++) {
    if (!(ts[i] > ts[i - 1])) return inc(detailBase, { reason: "timestamp not strictly increasing" });
  }

  const duration = ts[ts.length - 1] - ts[0];
  if (!(duration >= MIN_DURATION_S)) {
    return inc(detailBase, { reason: "episode shorter than 1s", duration_s: duration });
  }

  const embodiment = byId(embodimentId);
  if (embodiment?.jointLimits && embodiment.jointLimits.length !== dof) {
    // Edge case (TASK-017.md): "D mismatch (skip, inconclusive)" — the
    // declared embodiment's joint count disagrees with the data; do not
    // silently fall back to per-episode min/max, which would compare
    // incompatible joint semantics.
    return inc(detailBase, {
      reason: "joint count mismatch",
      embodiment_id: embodimentId,
      state_dof: dof,
      embodiment_dof: embodiment.jointLimits.length,
    });
  }
  const { normalized, normalisation } = normaliseState(state, embodiment?.jointLimits);
  const resampled = resampleLinear(normalized, ts, TARGET_HZ);

  if (resampled.length < 2) {
    return inc(detailBase, { reason: "resampled trajectory too short", normalisation });
  }

  const candidates = index.query(resampled, embodimentId, leaf, 50);

  let nearest: { leaf: string; d: number } | null = null;
  for (const c of candidates) {
    if (c.trajectory.length === 0 || c.trajectory[0].length !== dof) continue; // defensive: same-embodiment DOF mismatch
    const dtw = bandedDtw(resampled, c.trajectory, DTW_BAND_FRACTION);
    const d = dtw / (resampled.length + c.trajectory.length);
    if (nearest === null || d < nearest.d) nearest = { leaf: c.leaf, d };
  }

  let result: CheckResult;
  const detail: JsonObject & { check_version: string; thresholds: JsonObject } = {
    ...detailBase,
    normalisation,
    nearest: nearest ? ({ leaf: nearest.leaf, d: nearest.d } as unknown as JsonObject) : null,
    candidates_considered: candidates.length,
    index_snapshot: index.rowCount(),
  };

  if (nearest && nearest.d < thresholds.T_exact) {
    if (config.emit_fail) {
      result = "fail";
    } else {
      result = "inconclusive";
      detail.downgraded_from = "fail";
    }
  } else if (nearest && nearest.d < thresholds.T_near) {
    result = "inconclusive";
  } else {
    result = "pass";
  }

  // Insert after deciding (TASK-017.md step 6) — never before, so a
  // fingerprint is never compared to itself.
  index.insert(leaf, embodimentId, resampled);

  return { result, level: 3, detail };
}
