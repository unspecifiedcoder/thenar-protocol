/* hotaru.js — the shipped robot, turning, in the proof card.
 *
 * A visitor deciding whether to believe a hardware claim wants to see the
 * hardware. This is the same rig the Hotaru site renders, posed to its neutral
 * stance and rotated slowly, with no controls: it is evidence, not a toy.
 *
 * Deliberately lazy. The GLB is 2.3 MB and sits far down the page, so nothing
 * is fetched until the card is actually near the viewport.
 */
import { M4, loadGLB, makeGL } from "./gl.js";

export function mountHotaru(cv) {
  let started = false;

  const boot = () => {
    if (started) return;
    started = true;
    run(cv).catch(e => {
      // A dead canvas is worse than no canvas: drop it and let the card close
      // up rather than leaving a black rectangle that looks broken.
      console.error("hotaru:", e);
      cv.closest(".viz")?.remove();
    });
  };

  if (!("IntersectionObserver" in window)) return boot();
  const io = new IntersectionObserver(es => {
    if (es.some(e => e.isIntersecting)) { io.disconnect(); boot(); }
  }, { rootMargin: "600px" });
  io.observe(cv);
}

async function run(cv) {
  const { gl, prog, U } = makeGL(cv);
  const [nodes, rig] = await Promise.all([
    loadGLB("./hotaru-rig.glb"),
    fetch("./rig.json").then(r => r.json()),
  ]);

  // rig.loose is the spares tray: horns, the spline test coupon, the retainer
  // tabs. The parts viewer lays them out beside the robot on purpose, but here
  // they would strew across the card and drag the framing off the assembly.
  const loose = new Set(rig.loose || []);
  const parts = nodes.filter(n => !loose.has(n.name)).map(n => {
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
    return { name: n.name, vao, count: n.idx.length, color: n.color, lo, hi,
             itype: n.idx.BYTES_PER_ELEMENT === 2 ? gl.UNSIGNED_SHORT
                                                  : gl.UNSIGNED_INT,
             model: M4.id() };
  });

  // Forward kinematics down the arm chain, same walk assembly.world_items()
  // does in the CAD: each segment inherits its parent's cumulative angle.
  const J = ["base", "shoulder", "elbow", "head"];
  function pose() {
    const N = rig.neutral;
    let p = rig.pivot.slice(), cum = N.base;
    rig.segments.forEach((seg, i) => {
      const M = M4.mul(M4.trans(p[0], p[1], p[2]), M4.rotX(cum));
      for (const nm of seg.parts.concat(seg.servo)) {
        const q = parts.find(x => x.name === nm);
        if (q) q.model = M;
      }
      const a = cum * Math.PI / 180;
      p = [p[0], p[1] - seg.length * Math.sin(a), p[2] + seg.length * Math.cos(a)];
      cum += N[J[i + 1]];
    });
    const sh = parts.find(x => x.name === rig.shade);
    if (sh) sh.model = M4.mul(M4.trans(p[0], p[1], p[2]), M4.rotX(cum + 180));
  }
  pose();

  // frame the whole posed assembly, not just the base
  const lo = [1e9, 1e9, 1e9], hi = [-1e9, -1e9, -1e9];
  for (const q of parts) for (let c = 0; c < 8; c++) {
    const v = [c & 1 ? q.hi[0] : q.lo[0], c & 2 ? q.hi[1] : q.lo[1],
               c & 4 ? q.hi[2] : q.lo[2]];
    for (let k = 0; k < 3; k++) {
      const w = q.model[k]*v[0] + q.model[4+k]*v[1] + q.model[8+k]*v[2] + q.model[12+k];
      if (w < lo[k]) lo[k] = w;
      if (w > hi[k]) hi[k] = w;
    }
  }
  const ctr = [(lo[0]+hi[0])/2, (lo[1]+hi[1])/2, (lo[2]+hi[2])/2];
  const dist = Math.max(hi[0]-lo[0], hi[1]-lo[1], hi[2]-lo[2]) * 1.55;

  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let az = -0.5;
  cv.closest(".viz")?.classList.add("ready");

  function frame(now) {
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = cv.clientWidth | 0, h = cv.clientHeight | 0;
    if (!w || !h) { requestAnimationFrame(frame); return; }
    if (cv.width !== w * dpr || cv.height !== h * dpr) {
      cv.width = w * dpr; cv.height = h * dpr;
    }
    if (!reduced) az = -0.5 + now / 9000;

    gl.viewport(0, 0, cv.width, cv.height);
    gl.clearColor(0.094, 0.094, 0.094, 1);          // --surface
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const el = 0.16;
    const eye = [ctr[0] + dist*Math.cos(el)*Math.sin(az),
                 ctr[1] + dist*Math.cos(el)*Math.cos(az),
                 ctr[2] + dist*Math.sin(el)];
    const V = M4.look(eye, ctr, [0, 0, 1]);
    const P = M4.persp(0.62, cv.width / cv.height, 10, 5000);

    gl.useProgram(prog);
    for (const q of parts) {
      const mv = M4.mul(V, q.model);
      gl.uniformMatrix4fv(U.mv, false, mv);
      gl.uniformMatrix4fv(U.mvp, false, M4.mul(P, mv));
      gl.uniform3fv(U.col, q.color);
      gl.bindVertexArray(q.vao);
      gl.drawElements(gl.TRIANGLES, q.count, q.itype, 0);
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
