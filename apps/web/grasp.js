/* grasp.js — the argument, made watchable.
 *
 * The whole company rests on one claim: a camera cannot see the moment a grip
 * fails. Asserting that in a paragraph is worth nothing, so this plays the
 * event instead. One grasp of a glass, 2.4 seconds, two synchronised tracks:
 *
 *   POSE   what a perfect vision system recovers. Smooth, and at the instant
 *          that matters it carries a 0.9 mm wobble, which is inside the noise
 *          floor of every hand tracker there is.
 *   FORCE  what the band records. The load collapses as the glass starts to
 *          go, then the corrective squeeze lands about 70 ms later.
 *
 * The numbers are a model, not a capture, and the page says so underneath.
 * They follow the shape the grip literature reports for slip and the reflex
 * that answers it; they are not measurements from a device we have not built.
 */

const BLUE = "#4D17F5", PINK = "#FA9DCD", MUTE = "#6E6E6E", LINE = "#272727";
const FG = "#FFFFFF", DIM = "#9B9B9B";

const T_END = 2.4;
const T_SLIP = 1.38;          // load starts to collapse
const T_FIX = 1.46;           // corrective squeeze begins

const ease = x => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);

/* Grip force in newtons. */
export function force(t) {
  if (t < 0.50) return 0;                                   // approach, no contact
  if (t < 0.90) return ease((t - 0.50) / 0.40) * 8.2;       // fingers load up
  if (t < T_SLIP) return 8.2 + Math.sin((t - 0.90) * 9) * 0.16;   // holding
  if (t < T_FIX) return 8.2 - ease((t - T_SLIP) / 0.08) * 2.6;    // slip: load falls
  if (t < 1.58) return 5.6 + ease((t - T_FIX) / 0.12) * 8.6;      // reflex squeeze
  return 14.2 - ease(Math.min((t - 1.58) / 0.5, 1)) * 3.1
              + Math.sin((t - 1.58) * 7) * 0.10;             // settle, higher margin
}

/* Hand height in millimetres, which is all vision really gives you here. The
   glass slips inside the fingers; the hand itself barely moves, and that is
   exactly why the pose track is useless at T_SLIP. */
export function pose(t) {
  const lift = t < 0.90 ? 0 : ease(Math.min((t - 0.90) / 1.20, 1)) * 62;
  const wob = (t > T_SLIP && t < 1.62) ? Math.sin((t - T_SLIP) * 42) * 0.9 : 0;
  return lift + wob;
}

const F_MAX = 16, P_MAX = 70;

export function makeGrasp(cv, onTick) {
  const ctx = cv.getContext("2d");
  let t = 0, playing = true, scrub = null, raf = null, last = 0;

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;

  function layout() {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = cv.clientWidth | 0, h = cv.clientHeight | 0;
    if (cv.width !== w * dpr || cv.height !== h * dpr) {
      cv.width = w * dpr; cv.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  /* One lane: label, axis, the curve up to `t`, and the value readout. */
  function lane(box, title, unit, fn, max, colour, faint) {
    const { x, y, w, h } = box;
    ctx.strokeStyle = LINE; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(x, y + h + .5); ctx.lineTo(x + w, y + h + .5);
    ctx.stroke();

    ctx.font = "600 11px Manrope, system-ui, sans-serif";
    ctx.fillStyle = faint ? MUTE : DIM;
    ctx.fillText(title, x, y - 10);

    // the curve, drawn only as far as the playhead so it reads as a recording
    ctx.beginPath();
    const n = 260;
    for (let i = 0; i <= n; i++) {
      const tt = (i / n) * t;
      const px = x + (tt / T_END) * w;
      const py = y + h - (fn(tt) / max) * h;
      i ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.strokeStyle = colour;
    ctx.lineWidth = faint ? 1.75 : 2.5;
    ctx.lineJoin = ctx.lineCap = "round";
    ctx.stroke();

    // head dot
    const hx = x + (t / T_END) * w, hy = y + h - (fn(t) / max) * h;
    ctx.beginPath(); ctx.arc(hx, hy, faint ? 3 : 4.5, 0, 7);
    ctx.fillStyle = colour; ctx.fill();

    ctx.font = "700 20px Manrope, system-ui, sans-serif";
    ctx.fillStyle = faint ? DIM : FG;
    const v = fn(t).toFixed(1) + unit;
    ctx.fillText(v, x + w - ctx.measureText(v).width, y - 6);
  }

  function draw() {
    const { w, h } = layout();
    ctx.clearRect(0, 0, w, h);

    const padL = 4, padR = 4;
    const iw = w - padL - padR;
    const laneH = (h - 96) / 2;
    const poseBox  = { x: padL, y: 34,               w: iw, h: laneH };
    const forceBox = { x: padL, y: 34 + laneH + 62,  w: iw, h: laneH };

    // the slip band, drawn behind both lanes so the eye links them
    const sx = padL + (T_SLIP / T_END) * iw;
    const fx = padL + (T_FIX / T_END) * iw;
    ctx.fillStyle = "rgba(77,23,245,.20)";
    ctx.fillRect(sx, 20, Math.max(fx - sx, 2), h - 44);
    ctx.strokeStyle = BLUE; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(sx + .5, 20); ctx.lineTo(sx + .5, h - 24); ctx.stroke();

    if (t >= T_SLIP) {
      ctx.font = "700 10px Manrope, system-ui, sans-serif";
      ctx.fillStyle = BLUE;
      ctx.fillText("SLIP", sx + 6, h - 10);
    }

    lane(poseBox,  "POSE FROM VIDEO", " mm", pose,  P_MAX, MUTE, true);
    lane(forceBox, "GRIP FORCE",      " N",  force, F_MAX, PINK, false);

    if (onTick) onTick(t, force(t));
  }

  function frame(now) {
    if (!last) last = now;
    const dt = Math.min((now - last) / 1000, 0.05);
    last = now;
    if (playing && scrub === null) {
      t += dt;
      // hold on the settled grip for a beat before looping, so the correction
      // is legible rather than flashing past
      if (t > T_END + 0.9) t = 0;
      if (t > T_END) t = T_END;
    }
    draw();
    raf = requestAnimationFrame(frame);
  }

  function at(clientX) {
    const r = cv.getBoundingClientRect();
    return Math.max(0, Math.min(T_END, ((clientX - r.left) / r.width) * T_END));
  }
  cv.addEventListener("pointerdown", e => {
    scrub = e.pointerId; cv.setPointerCapture(e.pointerId);
    t = at(e.clientX); draw();
  });
  cv.addEventListener("pointermove", e => {
    if (scrub === e.pointerId) { t = at(e.clientX); draw(); }
  });
  const release = e => { if (scrub === e.pointerId) { scrub = null; } };
  cv.addEventListener("pointerup", release);
  cv.addEventListener("pointercancel", release);

  // Reduced motion gets the finished trace, parked on the correction, rather
  // than a loop that never stops moving.
  if (reduced) { playing = false; t = 1.62; draw(); }
  else raf = requestAnimationFrame(frame);

  return {
    toggle() { playing = !playing; if (playing && t >= T_END) t = 0; return playing; },
    replay() { t = 0; playing = true; },
    get playing() { return playing; },
  };
}
