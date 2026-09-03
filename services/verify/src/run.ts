/**
 * T-018/T-019 — thin adapter wiring `timing.v1` / `kinematics.v1` /
 * `sensor_consistency.v1` / `sim_signature.v1` to a real episode read via
 * `readEpisodeFrames` (`services/api/src/ingest/lerobot.ts`, T-011). T-020's
 * worker will call the checks directly with its own frame-loading path;
 * this adapter is for anything (CLI, tests) that only has an `EpisodeRef`
 * and a dataset directory.
 *
 * Video motion (T-019): the window is `ref.range.video[camera]` for the
 * first camera present (LeRobot datasets without chunked ranges, or
 * without a video channel, have `range: null` / an empty `video` map —
 * both checks then see `motion: null`, which `sensor_consistency.v1`
 * treats as `inconclusive` and `sim_signature.v1` treats as "skip feature
 * 4"). `motion` is computed once via the injected `MotionEnergyProvider`
 * (default `FfmpegMotionEnergy`, `src/video/motion.ts`) and shared between
 * both checks. A `FfmpegUnavailable` (binary missing, spawn failure, bad
 * output) is caught here and turned into the named skip both checks'
 * "no video" paths already speak: `motion = null` plus a
 * `ffmpeg_error: "ffmpeg unavailable"` marker folded into each outcome's
 * `detail` (TASK-019.md supervisor adjustment: "skip loudly … `detail.reason
 * = 'ffmpeg unavailable'`").
 */
import type { EpisodeRef } from "../../api/src/ingest/lerobot.ts";
import { readEpisodeFrames } from "../../api/src/ingest/lerobot.ts";
import { timingCheck } from "./checks/timing.ts";
import { kinematicsCheck } from "./checks/kinematics.ts";
import { sensorConsistencyCheck } from "./checks/sensor_consistency.ts";
import { simSignatureCheck, type SimSignatureSource } from "./checks/sim_signature.ts";
import { FfmpegMotionEnergy, FfmpegUnavailable, type MotionEnergyProvider } from "./video/motion.ts";
import type { CheckOutcome } from "./types.ts";

export async function runOnEpisode(
  ref: EpisodeRef,
  dir: string,
  opts: { source?: SimSignatureSource; motionProvider?: MotionEnergyProvider } = {},
): Promise<{
  timing: CheckOutcome;
  kinematics: CheckOutcome;
  sensor_consistency: CheckOutcome;
  sim_signature: CheckOutcome;
}> {
  const columns = ["timestamp", "observation.state", "action"];
  const frames = await readEpisodeFrames(ref, dir, columns);

  const timestamp = Array.from(frames.timestamp as Float32Array | Float64Array | number[]);
  const timing = timingCheck({ timestamp }, ref.rateHz, ref.durationMs);

  const state = frames["observation.state"] as unknown as number[][];
  const rawAction = frames.action as unknown as number[][] | undefined;
  const action = rawAction && rawAction.length > 0 ? rawAction : undefined;
  const kinematics = kinematicsCheck({ state, action }, ref.embodiment ?? "", ref.rateHz);

  const { motion, ffmpegError } = await computeMotion(ref, dir, opts.motionProvider ?? new FfmpegMotionEnergy());

  const source: SimSignatureSource = opts.source ?? "real";
  const sensorFrames = { timestamp, state };

  let sensor_consistency = sensorConsistencyCheck(sensorFrames, motion);
  let sim_signature = simSignatureCheck(sensorFrames, motion, source);

  if (ffmpegError) {
    // Supervisor adjustment: the real (ffmpeg) path skips loudly —
    // `inconclusive`, `detail.reason = "ffmpeg unavailable"`.
    // `sensor_consistency.v1` is already `inconclusive` here (its
    // `motion === null` path); its generic "no video" reason is replaced
    // with the more specific one. `sim_signature.v1` doesn't gate its
    // whole result on video (only feature 4 needs it), so it keeps
    // whatever `pass`/`inconclusive` the other three features produced,
    // annotated with the same marker.
    sensor_consistency = {
      ...sensor_consistency,
      detail: { ...sensor_consistency.detail, reason: ffmpegError },
    };
    sim_signature = {
      ...sim_signature,
      detail: { ...sim_signature.detail, ffmpeg_error: ffmpegError },
    };
  }

  return { timing, kinematics, sensor_consistency, sim_signature };
}

/**
 * Runs the motion provider over the episode's first video camera window
 * (`ref.range.video`), matched against the file entry whose path template
 * placed the camera name in its `videos/<camera>/…` prefix (T-011's
 * `videoPathTemplate`s). Returns `motion: null` — never throws — when
 * there's no video window, no matching file, or the provider fails; a
 * `FfmpegUnavailable` is what "fails" loudly, per this task's supervisor
 * adjustment.
 */
async function computeMotion(
  ref: EpisodeRef,
  dir: string,
  provider: MotionEnergyProvider,
): Promise<{ motion: number[] | null; ffmpegError: string | null }> {
  if (!ref.range || !ref.range.video) return { motion: null, ffmpegError: null };
  const cameras = Object.keys(ref.range.video);
  if (cameras.length === 0) return { motion: null, ffmpegError: null };

  const camera = cameras[0];
  const [t0, t1] = ref.range.video[camera];
  const file = ref.files.find((f) => f.path.startsWith(`videos/${camera}/`));
  if (!file) return { motion: null, ffmpegError: null };

  const abs = `${dir}/${file.path}`;
  try {
    const motion = await provider.energy(abs, t0, t1, 5);
    return { motion, ffmpegError: null };
  } catch (err) {
    if (err instanceof FfmpegUnavailable) {
      return { motion: null, ffmpegError: "ffmpeg unavailable" };
    }
    throw err;
  }
}
