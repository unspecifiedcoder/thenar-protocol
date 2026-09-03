/**
 * T-019 — `sensor_consistency.v1` unit tests (TASK-019.md "Tests"):
 * moving vs still fake motion, no-video path, downgrade path (FD-2 —
 * never emits `fail`), and the in-memory `MotionEnergyProvider` fake used
 * in place of `ffmpeg` (not installed here — this task's supervisor
 * adjustment).
 */
import { sensorConsistencyCheck, CHECK_VERSION, DEFAULT_THRESHOLDS } from "../src/checks/sensor_consistency.ts";
import type { MotionEnergyProvider } from "../src/video/motion.ts";
import { FfmpegMotionEnergy, FfmpegUnavailable } from "../src/video/motion.ts";

let fails = 0;
const ok = (c: boolean, m: string, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };

const RATE = 30;
const DOF = 6;

/** N frames at RATE Hz, joint j oscillating with amplitude/frequency scaled by j, starting at t=0. */
function movingState(n: number, rate = RATE, dof = DOF): { timestamp: number[]; state: number[][] } {
  const timestamp = Array.from({ length: n }, (_, i) => i / rate);
  const state = timestamp.map((t) =>
    Array.from({ length: dof }, (_, j) => Math.sin(2 * Math.PI * (0.5 + 0.1 * j) * t)),
  );
  return { timestamp, state };
}

function stillState(n: number, rate = RATE, dof = DOF): { timestamp: number[]; state: number[][] } {
  const timestamp = Array.from({ length: n }, (_, i) => i / rate);
  const state = timestamp.map(() => new Array(dof).fill(0.1));
  return { timestamp, state };
}

/** A smooth, non-negative envelope — used as both a joint's instantaneous speed profile and a matching motion-energy profile below. */
function envelope(t: number): number {
  return 0.5 * (1 + Math.sin(2 * Math.PI * 0.4 * t));
}

/** An independent envelope (different frequencies/harmonics) for uncorrelated fixtures. */
function noiseEnvelope(t: number): number {
  const x = Math.sin(2 * Math.PI * 0.7 * t) + 0.3 * Math.sin(2 * Math.PI * 3.1 * t);
  return 0.5 * (1 + x / 1.3);
}

/**
 * A single-joint (rest padded to `dof`) trajectory whose finite-difference
 * speed matches `env(t)` almost exactly: joint 0's position is the Euler
 * integral of `env` over the actual timestamp grid, so
 * `(pos[i]-pos[i-1])/dt = env(ts[i])` by construction.
 */
function trajectoryFromSpeed(
  n: number,
  rate: number,
  env: (t: number) => number,
  dof = DOF,
): { timestamp: number[]; state: number[][] } {
  const timestamp = Array.from({ length: n }, (_, i) => i / rate);
  let pos = 0;
  const state: number[][] = [new Array(dof).fill(0)];
  for (let i = 1; i < n; i++) {
    const dt = timestamp[i] - timestamp[i - 1];
    pos += env(timestamp[i]) * dt;
    const row = new Array(dof).fill(0);
    row[0] = pos;
    state.push(row);
  }
  return { timestamp, state };
}

/** An in-memory `MotionEnergyProvider` fake driven by a supplied `(t) => energy` function, sampled at 5 Hz over `[t0, t1]`. */
class FakeMotionEnergy implements MotionEnergyProvider {
  constructor(private fn: (t: number) => number) {}
  async energy(_file: string, t0: number, t1: number, fps: 5): Promise<number[]> {
    const out: number[] = [];
    for (let t = t0; t < t1; t += 1 / fps) out.push(this.fn(t));
    return out;
  }
}

// --- moving joints + correlated video motion -> high rho, pass ------------
{
  const { timestamp, state } = trajectoryFromSpeed(300, RATE, envelope); // 10s at 30Hz
  const fake = new FakeMotionEnergy((t) => envelope(t) * 50);
  const motion = await fake.energy("fake", 0, 10, 5);
  const out = sensorConsistencyCheck({ timestamp, state }, motion);
  ok(out.result === "pass", "correlated motion (moving joints, moving video) passes", JSON.stringify(out.detail));
  ok(out.level === 3, "level is 3");
  ok(out.detail.check_version === CHECK_VERSION, "detail carries check_version");
  ok(JSON.stringify(out.detail.thresholds) === JSON.stringify(DEFAULT_THRESHOLDS), "detail carries thresholds");
  ok(typeof out.detail.rho === "number" && (out.detail.rho as number) > DEFAULT_THRESHOLDS.rho_pass, "rho above rho_pass");
}

// --- moving joints, uncorrelated video motion -> low rho, downgraded fail (FD-2) ---
{
  const { timestamp, state } = trajectoryFromSpeed(300, RATE, envelope);
  const fake = new FakeMotionEnergy((t) => noiseEnvelope(t) * 50); // unrelated envelope, rho ~ 0
  const motion = await fake.energy("fake", 0, 10, 5);
  const out = sensorConsistencyCheck({ timestamp, state }, motion);
  ok(out.result === "inconclusive", "uncorrelated (non-degenerate) motion is never fail (FD-2)", JSON.stringify(out.detail));
  ok(out.detail.downgraded_from === "fail", "would-be fail is downgraded and recorded");
  ok(typeof out.detail.rho === "number" && (out.detail.rho as number) < DEFAULT_THRESHOLDS.rho_fail, "rho below rho_fail");
}

// --- still joints + moving video (both mismatched and degenerate) -> inconclusive
{
  const { timestamp, state } = stillState(300);
  const fake = new FakeMotionEnergy((t) => Math.abs(Math.sin(2 * Math.PI * 0.7 * t)) * 80 + (t * 13 % 1) * 5);
  const motion = await fake.energy("fake", 0, 10, 5);
  const out = sensorConsistencyCheck({ timestamp, state }, motion);
  ok(out.result === "inconclusive", "still joints vs moving video is never fail (FD-2)");
  ok(out.detail.downgraded_from === "fail" || out.detail.reason === "degenerate variance",
    "either downgraded from fail, or degenerate (constant state has zero variance)");
}

// --- moving joints, still video (zero variance motion) -> degenerate, inconclusive
{
  const { timestamp, state } = movingState(300);
  const motion = new Array(50).fill(7); // constant motion energy: zero variance
  const out = sensorConsistencyCheck({ timestamp, state }, motion);
  ok(out.result === "inconclusive", "zero-variance motion series is inconclusive (degenerate)");
  ok(out.detail.result !== "fail", "never fail");
  ok(out.detail.reason === "degenerate variance", "reason names the degeneracy");
}

// --- no video -> inconclusive ---------------------------------------------
{
  const { timestamp, state } = movingState(60);
  const out = sensorConsistencyCheck({ timestamp, state }, null);
  ok(out.result === "inconclusive", "no video is inconclusive");
  ok(out.detail.reason === "no video", "reason is 'no video'");
}

// --- moderate correlation lands strictly between thresholds -> inconclusive, not downgraded
{
  const { timestamp, state } = trajectoryFromSpeed(300, RATE, envelope);
  // Motion is a 20/80 blend of the joint's own envelope and an independent
  // one (measured offline to land rho ~0.3, strictly between rho_fail=0.2
  // and rho_pass=0.4).
  const w = 0.2;
  const fake = new FakeMotionEnergy((t) => (w * envelope(t) + (1 - w) * noiseEnvelope(t)) * 50);
  const motion = await fake.energy("fake", 0, 10, 5);
  const out = sensorConsistencyCheck({ timestamp, state }, motion);
  ok(out.result === "inconclusive", "mid-range rho is inconclusive", JSON.stringify(out.detail));
  const rho = out.detail.rho as number;
  ok(typeof rho === "number" && rho >= DEFAULT_THRESHOLDS.rho_fail && rho < DEFAULT_THRESHOLDS.rho_pass,
    "rho lands strictly between rho_fail and rho_pass", String(rho));
  ok(out.detail.downgraded_from === undefined, "mid-range rho is not a downgrade from fail");
}

// --- ffmpeg-absent path: FfmpegMotionEnergy throws FfmpegUnavailable ------
{
  let threw = false;
  try {
    await new FfmpegMotionEnergy().energy("/nonexistent/path/to/video.mp4", 0, 1, 5);
  } catch (err) {
    threw = err instanceof FfmpegUnavailable;
  }
  ok(threw, "FfmpegMotionEnergy throws FfmpegUnavailable when ffmpeg/ffprobe cannot run");
}

console.log(fails === 0 ? "\nsensor_consistency.v1: all tests passed\n" : `\nsensor_consistency.v1: ${fails} test(s) failed\n`);
process.exit(fails ? 1 : 0);
