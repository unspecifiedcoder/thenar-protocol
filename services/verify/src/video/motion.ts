/**
 * T-019 — frame-difference motion energy for `sensor_consistency.v1`
 * (PLAN §10.9 id `0x0004`).
 *
 * `MotionEnergyProvider` is the injectable seam this task's supervisor
 * adjustment requires: `ffmpeg` is not installed in this environment, so
 * `sensor_consistency.v1`/`sim_signature.v1` and their tests are written
 * against this interface (an in-memory fake in tests), and only
 * `FfmpegMotionEnergy` — never exercised by `pnpm test:verify` here —
 * shells out to the real binary. When `ffmpeg`/`ffprobe` are absent (or
 * fail to spawn for any reason), `FfmpegMotionEnergy` throws
 * `FfmpegUnavailable`; callers (`src/run.ts`) catch it and skip loudly:
 * `inconclusive`, `detail.reason = "ffmpeg unavailable"`.
 */
import { spawn } from "node:child_process";

/** Thrown by `FfmpegMotionEnergy` whenever `ffmpeg`/`ffprobe` cannot be run (missing binary, spawn failure, non-zero exit, unparseable output). */
export class FfmpegUnavailable extends Error {
  constructor(message = "ffmpeg unavailable") {
    super(message);
    this.name = "FfmpegUnavailable";
  }
}

/**
 * Per-frame motion energy (mean absolute pixel value of the frame-to-frame
 * grayscale difference) over `[t0, t1]`, sampled at `fps` (fixed at 5 Hz —
 * PLAN §10.9 "implementation detail" for `sensor_consistency.v1`, TASK-019.md
 * "Rules": `m(t)` is motion energy at 5 Hz). `energy[k]` corresponds to
 * `t0 + k / fps` seconds.
 */
export interface MotionEnergyProvider {
  energy(file: string, t0: number, t1: number, fps: 5): Promise<number[]>;
}

/** Output width for the `scale` filter — kept small and fixed so frame size is known before decoding starts (see `FfmpegMotionEnergy` doc). */
const SCALE_WIDTH = 160;

/**
 * `ffprobe -show_entries stream=width,height` on the video's first video
 * stream. Used only to compute the scaled output height (`ffmpeg`'s `-2`
 * scale spec rounds to the nearest even number of the *same* aspect ratio;
 * `rawvideo` output has no header, so the frame byte-stride must be known
 * up front to slice the byte stream into frames — hence probing first
 * rather than parsing an on-the-fly header).
 */
function probeDimensions(file: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn("ffprobe", [
        "-v", "error",
        "-select_streams", "v:0",
        "-show_entries", "stream=width,height",
        "-of", "csv=s=x:p=0",
        file,
      ]);
    } catch (err) {
      reject(new FfmpegUnavailable(`ffprobe spawn failed: ${err instanceof Error ? err.message : String(err)}`));
      return;
    }
    let out = "";
    let settled = false;
    proc.stdout.on("data", (d: Buffer) => { out += d.toString("utf8"); });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(new FfmpegUnavailable(`ffprobe spawn failed: ${err.message}`));
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      if (code !== 0) {
        reject(new FfmpegUnavailable(`ffprobe exited with code ${code}`));
        return;
      }
      const m = /(\d+)x(\d+)/.exec(out.trim());
      if (!m) {
        reject(new FfmpegUnavailable(`ffprobe: could not parse dimensions from "${out.trim()}"`));
        return;
      }
      resolve({ width: Number(m[1]), height: Number(m[2]) });
    });
  });
}

/**
 * Real implementation (TASK-019.md "Files"): `ffmpeg -ss t0 -to t1 -i file
 * -vf "fps=5,format=gray,scale=160:-2,tblend=all_mode=difference" -f
 * rawvideo -`. The `scale=160:-2` term is this implementation's documented
 * choice for turning `rawvideo`'s headerless byte stream into known-size
 * frames: width is fixed at 160 px, height is computed here (via `ffprobe`)
 * the same way `-2` would pick it (aspect-preserving, rounded down to an
 * even number), so the frame byte-stride (`width * height`, one byte per
 * pixel for `format=gray`) is known before any bytes arrive. Motion energy
 * per frame is the mean pixel value of that frame's bytes — after
 * `tblend=all_mode=difference` the bytes already are unsigned
 * frame-to-frame absolute differences, so no extra `abs()` is needed.
 */
export class FfmpegMotionEnergy implements MotionEnergyProvider {
  async energy(file: string, t0: number, t1: number, fps: 5): Promise<number[]> {
    const { width, height } = await probeDimensions(file);
    if (!(width > 0) || !(height > 0)) {
      throw new FfmpegUnavailable(`ffprobe: invalid dimensions ${width}x${height}`);
    }
    const scaledWidth = SCALE_WIDTH;
    const scaledHeight = Math.max(2, Math.floor((height * scaledWidth) / width / 2) * 2);
    const frameBytes = scaledWidth * scaledHeight;

    return new Promise((resolve, reject) => {
      const args = [
        "-ss", String(t0),
        "-to", String(t1),
        "-i", file,
        "-vf", `fps=${fps},format=gray,scale=${scaledWidth}:${scaledHeight},tblend=all_mode=difference`,
        "-f", "rawvideo",
        "-",
      ];
      let proc;
      try {
        proc = spawn("ffmpeg", args);
      } catch (err) {
        reject(new FfmpegUnavailable(`ffmpeg spawn failed: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      const chunks: Buffer[] = [];
      let settled = false;
      proc.stdout.on("data", (d: Buffer) => chunks.push(d));
      proc.stderr.on("data", () => {}); // drained, not inspected
      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(new FfmpegUnavailable(`ffmpeg spawn failed: ${err.message}`));
      });
      proc.on("close", (code) => {
        if (settled) return;
        settled = true;
        if (code !== 0) {
          reject(new FfmpegUnavailable(`ffmpeg exited with code ${code}`));
          return;
        }
        const buf = Buffer.concat(chunks);
        const frames: number[] = [];
        for (let off = 0; off + frameBytes <= buf.length; off += frameBytes) {
          let sum = 0;
          for (let i = 0; i < frameBytes; i++) sum += buf[off + i];
          frames.push(sum / frameBytes);
        }
        resolve(frames);
      });
    });
  }
}
