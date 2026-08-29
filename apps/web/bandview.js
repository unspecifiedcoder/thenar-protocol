/* bandview.js — the Thenar Band, assembled and coming apart.
 *
 * One 100 kB GLB carries every part in world coordinates; band.json carries
 * the direction each one leaves along. So assembled and exploded are two ends
 * of one interpolation rather than two files, and the scroll position through
 * the hero drives it: the product turns, then takes itself apart as you read
 * about it.
 *
 * Explode is critically damped on purpose. This transition is doing
 * explanatory work (which part came from where), and parts flying past their
 * slot and springing back would misrepresent how the thing goes together.
 */
import { M4, loadGLB, makeGL } from "./gl.js";

export async function mountBandView(cv, opts = {}) {
  // Same viewer drives the Band and the Quest capture rig: both exports use
  // the indexed normal-free GLB plus a sidecar carrying per-part explode
  // vectors, so nothing here needs to know which one it is looking at.
  const glb = opts.glb || "./band.glb";
  const json = opts.json || "./band.json";
  const { gl, prog, U } = makeGL(cv);
  const [nodes, meta] = await Promise.all([
    loadGLB(glb),
    fetch(json).then(r => r.json()),
  ]);

  const info = new Map(meta.parts.map(p => [p.name, p]));

  const parts = nodes.map(n => {
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vb);
    gl.bufferData(gl.ARRAY_BUFFER, n.pos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, n.idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (let i = 0; i < n.pos.length; i += 3)
      for (let k = 0; k < 3; k++) {
        if (n.pos[i + k] < lo[k]) lo[k] = n.pos[i + k];
        if (n.pos[i + k] > hi[k]) hi[k] = n.pos[i + k];
      }
    return { name: n.name, vao, count: n.idx.length, colour: n.color, lo, hi,
             itype: n.idx.BYTES_PER_ELEMENT === 2 ? gl.UNSIGNED_SHORT
                                                  : gl.UNSIGNED_INT,
             off: (info.get(n.name) || {}).explode || [0, 0, 0],
             dim: 0, dimT: 0, model: M4.id() };
  });

  // Corner points of every part, in the two poses. Framing is solved against
  // these each frame rather than estimated from a bounding sphere: the
  // exploded spread is long and thin, so a sphere around the box diagonal
  // over-zooms badly, while the box's longest edge crops the corners as the
  // model turns. Solving it exactly is 32 dot products and always right.
  function corners(e) {
    const out = [];
    for (const p of parts)
      for (let c = 0; c < 8; c++)
        out.push([(c & 1 ? p.hi[0] : p.lo[0]) + p.off[0] * e,
                  (c & 2 ? p.hi[1] : p.lo[1]) + p.off[1] * e,
                  (c & 4 ? p.hi[2] : p.lo[2]) + p.off[2] * e]);
    return out;
  }
  function centre(pts) {
    const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
    for (const q of pts) for (let k = 0; k < 3; k++) {
      if (q[k] < lo[k]) lo[k] = q[k];
      if (q[k] > hi[k]) hi[k] = q[k];
    }
    return [0, 1, 2].map(i => (lo[i] + hi[i]) / 2);
  }

  const cross = (a, b) => [a[1]*b[2] - a[2]*b[1], a[2]*b[0] - a[0]*b[2],
                           a[0]*b[1] - a[1]*b[0]];
  const norm = v => { const l = Math.hypot(v[0], v[1], v[2]) || 1;
                      return [v[0]/l, v[1]/l, v[2]/l]; };
  const dot = (a, b) => a[0]*b[0] + a[1]*b[1] + a[2]*b[2];

  /* Smallest distance along `dir` that keeps every point inside both fields
     of view. A point sits inside when |x| <= tan(fovx/2) * (d - z), so each
     point sets a lower bound on d and the answer is the largest of them. */
  function fitDistance(pts, ctr, dir, tx, ty) {
    const za = dir, xa = norm(cross([0, 0, 1], za)), ya = cross(za, xa);
    let d = 0;
    for (const p of pts) {
      const w = [p[0] - ctr[0], p[1] - ctr[1], p[2] - ctr[2]];
      const qx = dot(w, xa), qy = dot(w, ya), qz = dot(w, za);
      d = Math.max(d, qz + Math.abs(qx) / tx, qz + Math.abs(qy) / ty);
    }
    return d;
  }

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  const st = { explode: opts.explode || 0, target: opts.explode || 0,
               az: opts.az ?? -0.7, spin: opts.spin !== false };
  const mix = (a, b, t) => a + (b - a) * t;

  function frame(now) {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = cv.clientWidth | 0, h = cv.clientHeight | 0;
    if (!w || !h) { requestAnimationFrame(frame); return; }
    if (cv.width !== w * dpr || cv.height !== h * dpr) {
      cv.width = w * dpr; cv.height = h * dpr;
    }

    st.explode += (st.target - st.explode) * (reduced ? 0.5 : 0.11);
    if (st.spin && !reduced) st.az = -0.7 + now / 7000;

    gl.viewport(0, 0, cv.width, cv.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const e0 = st.explode;
    const pts = corners(e0);
    const ctr = centre(pts);

    const fovy = 0.6;
    const aspect = cv.width / cv.height;
    const ty = Math.tan(fovy / 2), tx = ty * aspect;
    const el = 0.30;
    const dir = [Math.cos(el) * Math.sin(st.az),
                 Math.cos(el) * Math.cos(st.az),
                 Math.sin(el)];
    const dist = fitDistance(pts, ctr, dir, tx, ty) * 1.08;
    const eye = [ctr[0] + dist * dir[0], ctr[1] + dist * dir[1],
                 ctr[2] + dist * dir[2]];
    const V = M4.look(eye, ctr, [0, 0, 1]);
    const P = M4.persp(fovy, aspect, Math.max(dist * 0.02, 1), dist * 4);

    gl.useProgram(prog);
    for (const p of parts) {
      p.dim += (p.dimT - p.dim) * 0.16;
      const e = st.explode;
      const M = M4.trans(p.off[0] * e, p.off[1] * e, p.off[2] * e);
      const mv = M4.mul(V, M);
      gl.uniformMatrix4fv(U.mv, false, mv);
      gl.uniformMatrix4fv(U.mvp, false, M4.mul(P, mv));
      // dimming is a lerp toward the page background, so a highlighted part
      // reads without needing a second shader
      const k = 1 - p.dim * 0.82;
      gl.uniform3fv(U.col, new Float32Array(p.colour.map(c => c * k)));
      gl.bindVertexArray(p.vao);
      gl.drawElements(gl.TRIANGLES, p.count, p.itype, 0);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  // drag to orbit; dragging stops the idle spin so a visitor can hold a view
  let drag = null;
  cv.addEventListener("pointerdown", e => {
    drag = e.clientX; st.spin = false; cv.setPointerCapture(e.pointerId);
  });
  addEventListener("pointerup", () => { drag = null; });
  addEventListener("pointermove", e => {
    if (drag === null) return;
    st.az -= (e.clientX - drag) * 0.009;
    drag = e.clientX;
  });

  cv.closest(".stage3d")?.classList.add("ready");

  return {
    explode(v) { st.target = Math.max(0, Math.min(1, v)); },
    highlight(name) { for (const p of parts) p.dimT = !name || p.name === name ? 0 : 1; },
    parts: meta.parts,
    mount: meta.mount,
  };
}
