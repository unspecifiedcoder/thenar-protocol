/* scene.js — rebuild the world an episode was captured in, from its seed.
 *
 * This is the "auditable rather than merely stored" claim made visible: given
 * the published task and the seed the chain reports, anyone can reconstruct the
 * exact arrangement a demonstration happened in and see it. The draws are
 * hashes, not a floating-point PRNG, so the browser and the exporter agree
 * exactly — `scene.test.mjs` checks that against the TypeScript sampler.
 */
import { keccak256 } from "./keccak.js";

const pad = (v, bytes) => BigInt(v).toString(16).padStart(bytes * 2, "0");

class Draws {
  constructor(taskId, seed) { this.taskId = taskId.replace(/^0x/, ""); this.seed = seed; this.i = 0; }
  next() {
    return BigInt(keccak256("0x" + this.taskId + pad(this.seed, 8) + pad(this.i++, 4)));
  }
  unit() { return Number(this.next() >> 203n) / 2 ** 53; }
  range(r, fallback = 0) { return r ? r[0] + this.unit() * (r[1] - r[0]) : fallback; }
  int(r, fallback = 1) {
    if (!r) return fallback;
    const lo = Math.ceil(r[0]), hi = Math.floor(r[1]);
    return hi < lo ? lo : lo + Math.floor(this.unit() * (hi - lo + 1));
  }
  pick(xs) { return xs[Math.floor(this.unit() * xs.length) % xs.length]; }
}

/** Byte-identical to `packages/protocol/src/sampler.ts`. Draw order is fixed. */
export function sampleScene(spec, taskId, seed) {
  const d = new Draws(taskId, seed);
  const objects = [];
  for (const o of spec.world.objects) {
    const n = d.int(o.count, 1);
    for (let k = 0; k < n; k++) {
      objects.push({
        category: o.category,
        instance: d.pick(o.instances),
        x: d.range(o.x), y: d.range(o.y), z: d.range(o.z, 0), yaw: d.range(o.yaw, 0),
      });
    }
  }
  return {
    taskId, seed, base: spec.world.base, embodiment: spec.embodiment, objects,
    lightingIntensity: d.range(spec.world.lightingIntensity, 1),
    lightingTemperatureK: d.range(spec.world.lightingTemperatureK, 5000),
  };
}

export function sceneHash(scene) {
  const parts = [
    scene.base, scene.embodiment,
    ...scene.objects.map((o) =>
      `${o.category}|${o.instance}|${o.x.toFixed(6)}|${o.y.toFixed(6)}|${o.z.toFixed(6)}|${o.yaw.toFixed(6)}`),
    scene.lightingIntensity.toFixed(6), scene.lightingTemperatureK.toFixed(3),
  ];
  return keccak256("0x" + Array.from(new TextEncoder().encode(parts.join("\n")),
    (b) => b.toString(16).padStart(2, "0")).join(""));
}

/* ---------------------------------------------------------------- drawing */

const kelvinToRgb = (k) => {
  // A cheap but monotone approximation: warm below 5000 K, cool above.
  const t = Math.max(0, Math.min(1, (k - 2000) / 6000));
  return [255, Math.round(180 + t * 60), Math.round(120 + t * 130)];
};

/**
 * Plan view, because the thing worth seeing is where the objects were placed.
 * Drawn to the canvas' own pixels so it stays crisp, and it never invents an
 * object the spec did not declare.
 */
export function drawScene(cv, scene, spec) {
  const ctx = cv.getContext("2d");
  const dpr = Math.min(devicePixelRatio || 1, 2);
  const w = cv.clientWidth | 0, h = cv.clientHeight | 0;
  if (!w || !h) return;
  if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  // Bounds come from the spec's declared ranges, so the view frames the task
  // rather than whatever this particular sample happened to land on.
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const o of spec.world.objects) {
    lo = [Math.min(lo[0], o.x[0]), Math.min(lo[1], o.y[0])];
    hi = [Math.max(hi[0], o.x[1]), Math.max(hi[1], o.y[1])];
  }
  if (!isFinite(lo[0])) { lo = [0, 0]; hi = [1, 1]; }
  const padX = Math.max(0.08, (hi[0] - lo[0]) * 0.16), padY = Math.max(0.08, (hi[1] - lo[1]) * 0.16);
  lo = [lo[0] - padX, lo[1] - padY]; hi = [hi[0] + padX, hi[1] + padY];
  const sx = w / (hi[0] - lo[0]), sy = h / (hi[1] - lo[1]);
  const s = Math.min(sx, sy);
  const ox = (w - (hi[0] - lo[0]) * s) / 2, oy = (h - (hi[1] - lo[1]) * s) / 2;
  const X = (x) => ox + (x - lo[0]) * s;
  const Y = (y) => h - (oy + (y - lo[1]) * s);

  const [lr, lg, lb] = kelvinToRgb(scene.lightingTemperatureK);
  const warmth = Math.max(0.05, Math.min(0.5, scene.lightingIntensity * 0.22));

  // The declared envelope for each object: the range the curator authored.
  ctx.setLineDash([3, 4]);
  for (const o of spec.world.objects) {
    ctx.strokeStyle = "rgba(255,255,255,.12)";
    ctx.lineWidth = 1;
    ctx.strokeRect(X(o.x[0]), Y(o.y[1]), (o.x[1] - o.x[0]) * s, (o.y[1] - o.y[0]) * s);
  }
  ctx.setLineDash([]);

  // A light wash standing for the sampled lighting, so two seeds look different.
  const g = ctx.createRadialGradient(w * 0.5, h * 0.28, 8, w * 0.5, h * 0.28, Math.max(w, h) * 0.8);
  g.addColorStop(0, `rgba(${lr},${lg},${lb},${warmth})`);
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  scene.objects.forEach((o, i) => {
    const px = X(o.x), py = Y(o.y);
    const r = Math.max(7, Math.min(18, s * 0.045));
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(-o.yaw);
    ctx.fillStyle = i === 0 ? "#4D17F5" : "rgba(250,157,205,.85)";
    ctx.strokeStyle = "rgba(255,255,255,.5)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(-r, -r * 0.72, r * 2, r * 1.44, 3);
    ctx.fill(); ctx.stroke();
    // A tick showing yaw, since a rotated square is otherwise ambiguous.
    ctx.beginPath(); ctx.moveTo(r, 0); ctx.lineTo(r + 6, 0); ctx.stroke();
    ctx.restore();

    ctx.font = "600 10px Manrope, system-ui, sans-serif";
    ctx.fillStyle = "rgba(255,255,255,.62)";
    ctx.fillText(o.instance, px + r + 9, py + 3);
  });

  ctx.font = "600 10px Manrope, system-ui, sans-serif";
  ctx.fillStyle = "#6E6E6E";
  ctx.fillText(`SEED ${scene.seed} · ${scene.objects.length} OBJECT${scene.objects.length === 1 ? "" : "S"}`, 8, 15);
  const lbl = `${Math.round(scene.lightingTemperatureK)} K`;
  ctx.fillText(lbl, w - ctx.measureText(lbl).width - 8, 15);
}
