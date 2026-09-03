/**
 * T-018 — thin adapter wiring `timing.v1` / `kinematics.v1` to a real
 * episode read via `readEpisodeFrames` (`services/api/src/ingest/lerobot.ts`,
 * T-011). T-020's worker will call the checks directly with its own
 * frame-loading path; this adapter is for anything (CLI, tests) that only
 * has an `EpisodeRef` and a dataset directory.
 */
import type { EpisodeRef } from "../../api/src/ingest/lerobot.ts";
import { readEpisodeFrames } from "../../api/src/ingest/lerobot.ts";
import { timingCheck } from "./checks/timing.ts";
import { kinematicsCheck } from "./checks/kinematics.ts";
import type { CheckOutcome } from "./types.ts";

export async function runOnEpisode(
  ref: EpisodeRef,
  dir: string,
): Promise<{ timing: CheckOutcome; kinematics: CheckOutcome }> {
  const columns = ["timestamp", "observation.state", "action"];
  const frames = await readEpisodeFrames(ref, dir, columns);

  const timestamp = Array.from(frames.timestamp as Float32Array | Float64Array | number[]);
  const timing = timingCheck({ timestamp }, ref.rateHz, ref.durationMs);

  const state = frames["observation.state"] as unknown as number[][];
  const rawAction = frames.action as unknown as number[][] | undefined;
  const action = rawAction && rawAction.length > 0 ? rawAction : undefined;
  const kinematics = kinematicsCheck({ state, action }, ref.embodiment ?? "", ref.rateHz);

  return { timing, kinematics };
}
