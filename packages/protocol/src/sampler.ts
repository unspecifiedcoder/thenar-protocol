import { keccak256, concatHex, toHex, type Hex } from "viem";
import type { TaskSpec, ObjectSpec, Range } from "./taskspec";

/**
 * Turn (taskId, seed) into a concrete scene, deterministically.
 *
 * This is what makes an episode auditable rather than merely stored: given the
 * published spec and the seed recorded in the leaf, anyone can rebuild the
 * exact world a demonstration was captured in and check the claim themselves.
 *
 * The stream is derived by hashing, not by a floating-point PRNG, so the same
 * inputs give the same scene on every machine and in every language — the
 * moment a sampler drifts between the builder and the verifier, provenance is
 * worth nothing.
 */

export type PlacedObject = {
  category: string;
  instance: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
};

export type Scene = {
  taskId: Hex;
  seed: bigint;
  base: string;
  embodiment: string;
  objects: PlacedObject[];
  lightingIntensity: number;
  lightingTemperatureK: number;
};

/** Counter-mode hash stream: draw i is keccak(taskId ‖ seed ‖ i). */
class Draws {
  private i = 0;
  private readonly taskId: Hex;
  private readonly seed: bigint;

  // Plain fields rather than parameter properties: Node's strip-only
  // TypeScript mode cannot compile the shorthand, and this library has to run
  // unbuilt in scripts as well as bundled in the browser.
  constructor(taskId: Hex, seed: bigint) {
    this.taskId = taskId;
    this.seed = seed;
  }

  private next(): bigint {
    const h = keccak256(
      concatHex([this.taskId, toHex(this.seed, { size: 8 }), toHex(BigInt(this.i++), { size: 4 })]),
    );
    return BigInt(h);
  }

  /** Uniform in [0,1), from the top 53 bits so it maps cleanly onto a double. */
  unit(): number {
    return Number(this.next() >> 203n) / 2 ** 53;
  }

  range(r?: Range, fallback = 0): number {
    if (!r) return fallback;
    return r[0] + this.unit() * (r[1] - r[0]);
  }

  int(r?: Range, fallback = 1): number {
    if (!r) return fallback;
    const lo = Math.ceil(r[0]);
    const hi = Math.floor(r[1]);
    if (hi < lo) return lo;
    return lo + Math.floor(this.unit() * (hi - lo + 1));
  }

  pick<T>(xs: readonly T[]): T {
    return xs[Math.floor(this.unit() * xs.length) % xs.length];
  }
}

export function sampleScene(spec: TaskSpec, taskId: Hex, seed: bigint): Scene {
  const d = new Draws(taskId, seed);
  const objects: PlacedObject[] = [];

  // Order matters and is fixed: objects in declared order, each drawing count,
  // then instance, then pose. Any change here is a breaking change to every
  // episode already recorded.
  for (const o of spec.world.objects) {
    const n = d.int(o.count, 1);
    for (let k = 0; k < n; k++) {
      objects.push({
        category: o.category,
        instance: d.pick(o.instances),
        x: d.range(o.x),
        y: d.range(o.y),
        z: d.range(o.z, 0),
        yaw: d.range(o.yaw, 0),
      });
    }
  }

  return {
    taskId,
    seed,
    base: spec.world.base,
    embodiment: spec.embodiment,
    objects,
    lightingIntensity: d.range(spec.world.lightingIntensity, 1),
    lightingTemperatureK: d.range(spec.world.lightingTemperatureK, 5000),
  };
}

/** A stable digest of a sampled scene, for cross-checking a rebuild. */
export function sceneHash(scene: Scene): Hex {
  const parts = [
    scene.base,
    scene.embodiment,
    ...scene.objects.map((o) =>
      `${o.category}|${o.instance}|${o.x.toFixed(6)}|${o.y.toFixed(6)}|${o.z.toFixed(6)}|${o.yaw.toFixed(6)}`,
    ),
    scene.lightingIntensity.toFixed(6),
    scene.lightingTemperatureK.toFixed(3),
  ];
  return keccak256(toHex(parts.join("\n")));
}
