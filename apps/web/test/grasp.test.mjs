/**
 * The grasp timeline, tested without a browser: requestAnimationFrame is
 * throttled under automation, so the loop is driven directly with a fake clock.
 * The bug this pins: the loop reset was unreachable because `t` was clamped to
 * T_END on the line below it, so the trace played once and stuck.
 */
import { force, pose, makeGrasp } from "../grasp.js";

let fails = 0;
const ok = (c, m, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };
const T_END = 2.4;

ok(force(0) === 0 && force(0.4) === 0, "no contact before the fingers land");
ok(force(0.9) > 8 && force(0.9) < 8.5, "the hold sits near 8.2 N", force(0.9).toFixed(2));
const peak = Math.max(...Array.from({ length: 241 }, (_, i) => force(i / 100)));
ok(peak > 14 && peak < 14.5, "the corrective squeeze peaks near 14.2 N", peak.toFixed(2));
ok(force(2.4) > 10 && force(2.4) < 11.5, "it settles above the original hold", force(2.4).toFixed(2));
ok(pose(0.5) === 0, "the hand has not moved before the lift");
// The claim on the page is "pose movement at slip 0.9 mm". That is the
// oscillation, not the lift — the hand is genuinely rising several millimetres
// through this window. Isolate the wobble by measuring how far pose departs
// from a straight line across the slip.
const A = 1.22, B = 1.42;
let wobble = 0;
for (let i = 0; i <= 200; i++) {
  const t = A + (B - A) * (i / 200);
  const line = pose(A) + (pose(B) - pose(A)) * ((t - A) / (B - A));
  wobble = Math.max(wobble, Math.abs(pose(t) - line));
}
ok(wobble < 1, "the slip moves the hand under a millimetre — inside tracker noise",
   `${wobble.toFixed(2)} mm`);

const noop = () => {};
const ctx2d = new Proxy({}, { get: (_, k) => (k === "measureText" ? () => ({ width: 10 }) : noop) });
const canvas = {
  clientWidth: 400, clientHeight: 300, width: 0, height: 0,
  getContext: () => ctx2d, addEventListener: noop,
  getBoundingClientRect: () => ({ left: 0, width: 400 }), setPointerCapture: noop,
};
globalThis.matchMedia = () => ({ matches: false });
globalThis.devicePixelRatio = 2;
let frameCb = null;
globalThis.requestAnimationFrame = (cb) => { frameCb = cb; return 1; };
globalThis.cancelAnimationFrame = noop;

const seen = [];
const g = makeGrasp(canvas, (t, f) => seen.push([t, f]));
ok(typeof frameCb === "function", "the loop asks for a frame");

let now = 0;
for (let i = 0; i < 360; i++) { now += 16.7; frameCb(now); }   // ~6 s at 60fps

const ts = seen.map(([t]) => t);
ok(Math.max(...ts) <= T_END + 1e-9, "the playhead never draws past the end", Math.max(...ts).toFixed(3));
ok(seen.some(([, f]) => f > 14), "the correction is reached", Math.max(...seen.map(([, f]) => f)).toFixed(1));

let restarts = 0;
for (let i = 1; i < ts.length; i++) if (ts[i] < ts[i - 1] - 0.5) restarts++;
ok(restarts >= 1, "the trace loops rather than sticking at the end", `${restarts} restart(s) in 6 s`);

const held = ts.filter((t) => t >= T_END - 1e-9).length;
ok(held > 30, "it holds on the settled grip before looping", `${held} frames`);
ok(g.toggle() === false && g.toggle() === true, "pause and resume toggle");

console.log(fails === 0 ? "\ngrasp timeline: all checks passed\n" : `\n${fails} check(s) failed\n`);
process.exit(fails ? 1 : 0);
