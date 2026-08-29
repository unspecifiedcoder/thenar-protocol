/* band.js — three sensors, one clock.
 *
 * The Band's whole claim is that vision, inertial and contact are sampled
 * against a shared timebase at the source, instead of three recordings
 * aligned in software afterwards. That is an engineering claim you can draw:
 * three lanes at their real rates, every sample landing on the same grid.
 *
 * The rates are the design target for the unit, not a measurement.
 */
const LANES = [
  { name: "CONTACT",  hz: 1000, colour: "#FA9DCD", step: 3   },
  { name: "INERTIAL", hz: 200,  colour: "#4D17F5", step: 15  },
  { name: "VISION",   hz: 30,   colour: "#6E6E6E", step: 100 },
];

export function mountBand(cv) {
  const ctx = cv.getContext("2d");
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let t0 = null;

  function frame(now) {
    if (t0 === null) t0 = now;
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = cv.clientWidth | 0, h = cv.clientHeight | 0;
    if (!w || !h) { requestAnimationFrame(frame); return; }
    if (cv.width !== w * dpr || cv.height !== h * dpr) {
      cv.width = w * dpr; cv.height = h * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // px per millisecond, and the scroll offset, held to whole pixels so the
    // ticks do not shimmer as they move
    const pxms = 0.34;
    const shift = reduced ? 0 : ((now - t0) * pxms) % 300;

    const padX = 18, padTop = 30, laneGap = (h - padTop - 34) / 3;

    // the shared clock: one gridline every 100 ms, spanning every lane. This
    // is the actual point of the drawing.
    ctx.strokeStyle = "rgba(255,255,255,.07)";
    ctx.lineWidth = 1;
    for (let g = -1; g * 100 * pxms - shift < w + 40; g++) {
      const x = Math.round(padX + g * 100 * pxms - shift) + .5;
      if (x < padX || x > w - padX) continue;
      ctx.beginPath(); ctx.moveTo(x, padTop - 8); ctx.lineTo(x, h - 26); ctx.stroke();
    }

    ctx.font = "700 9px Manrope, system-ui, sans-serif";
    LANES.forEach((L, i) => {
      const y = padTop + laneGap * i + laneGap / 2;

      ctx.fillStyle = "#6E6E6E";
      ctx.fillText(L.name, padX, y - 12);
      const rate = L.hz >= 1000 ? (L.hz / 1000) + " kHz" : L.hz + " Hz";
      ctx.fillStyle = L.colour;
      ctx.fillText(rate, w - padX - ctx.measureText(rate).width, y - 12);

      ctx.strokeStyle = "rgba(255,255,255,.10)";
      ctx.beginPath(); ctx.moveTo(padX, y + .5); ctx.lineTo(w - padX, y + .5); ctx.stroke();

      // one tick per sample, spaced by rate
      ctx.strokeStyle = L.colour;
      ctx.lineWidth = L.hz >= 1000 ? 1 : 1.6;
      ctx.beginPath();
      for (let k = -2; ; k++) {
        const x = padX + k * L.step - (shift % L.step);
        if (x > w - padX) break;
        if (x < padX) continue;
        const xx = Math.round(x) + .5;
        ctx.moveTo(xx, y - 7); ctx.lineTo(xx, y + 7);
      }
      ctx.stroke();
    });

    if (!reduced) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
