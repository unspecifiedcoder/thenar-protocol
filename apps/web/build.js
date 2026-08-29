/* build.js — author a task without writing JSON.
 *
 * The definition of done for this page is specific: place objects, drag the
 * envelopes they may be sampled in, build a predicate a machine can check, and
 * publish — never editing a spec by hand. Dragging is the point: a curator who
 * has to type coordinates writes one arrangement, and one arrangement is a demo
 * rather than a dataset.
 */
import { EMBODIMENTS } from "./embodiments.js";
import { validateTaskSpec, taskId, PREDICATES, ACTION_SPACES } from "./taskspec.js";
import { sampleScene, drawScene } from "./scene.js";
import { MONAD } from "./grasp-chain.js";

const $ = (s) => document.querySelector(s);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

let seed = 1n;
let spec = {
  version: 1,
  embodiment: "franka_panda",
  actionSpace: "ee_pose_gripper",
  instruction: "Place the mug upright on the shelf",
  world: {
    base: "kitchen_counter_v2",
    objects: [
      { category: "mug", instances: ["mug_a", "mug_b", "mug_c"], x: [0.28, 0.42], y: [-0.15, 0.15], yaw: [0, 6.283] },
    ],
    lightingIntensity: [0.6, 1.4],
    lightingTemperatureK: [3000, 6500],
  },
  success: { predicate: "upright_on(mug, shelf) && settled(2.0)", toleranceMm: 25, settleS: 2 },
  acceptance: { minScoreBps: 5500, maxDurationS: 120, targetEpisodes: 500 },
};
let curatorBps = 1000;

/* ------------------------------------------------------------------ inputs */

function fillEmbodiments() {
  const sel = $("#b-emb");
  const byClass = {};
  for (const e of EMBODIMENTS) (byClass[e.class] ??= []).push(e);
  sel.innerHTML = Object.entries(byClass).map(([cls, list]) =>
    `<optgroup label="${cls.replace(/_/g, " ")}">` +
    list.map((e) => `<option value="${e.id}">${e.vendor} ${e.name} — ${e.dof} DoF</option>`).join("") +
    `</optgroup>`).join("");
  sel.value = spec.embodiment;
  $("#b-action").innerHTML = ACTION_SPACES.map((a) => `<option value="${a}">${a.replace(/_/g, " ")}</option>`).join("");
  $("#b-action").value = spec.actionSpace;
}

function embodimentHint() {
  const e = EMBODIMENTS.find((x) => x.id === spec.embodiment);
  $("#b-embhint").textContent = e
    ? `${e.dof} actuated joints · ${e.licence}${e.trademarkCheck ? " · check the trademark before shipping commercially" : ""}${e.note ? ` · ${e.note}` : ""}`
    : "";
}

function objectRow(o, i) {
  return `<div class="bobj" data-i="${i}">
    <header><b>Object ${i + 1}</b>
      <button type="button" class="btn sm ghost" data-remove="${i}">Remove</button></header>
    <label class="brow"><span>Category</span><input data-f="category" value="${o.category}"></label>
    <label class="brow"><span>Instances</span><input data-f="instances" value="${o.instances.join(", ")}"></label>
    <label class="brow"><span>x range m</span><span class="brange">
      <input data-f="x0" type="number" step="0.01" value="${o.x[0]}"> to
      <input data-f="x1" type="number" step="0.01" value="${o.x[1]}"></span></label>
    <label class="brow"><span>y range m</span><span class="brange">
      <input data-f="y0" type="number" step="0.01" value="${o.y[0]}"> to
      <input data-f="y1" type="number" step="0.01" value="${o.y[1]}"></span></label>
    <label class="brow"><span>yaw range rad</span><span class="brange">
      <input data-f="yaw0" type="number" step="0.1" value="${o.yaw?.[0] ?? 0}"> to
      <input data-f="yaw1" type="number" step="0.1" value="${o.yaw?.[1] ?? 0}"></span></label>
    <label class="brow"><span>count range</span><span class="brange">
      <input data-f="c0" type="number" step="1" value="${o.count?.[0] ?? 1}"> to
      <input data-f="c1" type="number" step="1" value="${o.count?.[1] ?? 1}"></span></label>
  </div>`;
}

function renderObjects() {
  $("#b-objects").innerHTML = spec.world.objects.map(objectRow).join("");
}

function readForm() {
  spec.embodiment = $("#b-emb").value;
  spec.actionSpace = $("#b-action").value;
  spec.instruction = $("#b-instr").value;
  spec.world.base = $("#b-base").value;
  spec.world.lightingIntensity = [+$("#b-li0").value, +$("#b-li1").value];
  spec.world.lightingTemperatureK = [+$("#b-lk0").value, +$("#b-lk1").value];
  spec.success = { predicate: $("#b-pred").value, toleranceMm: +$("#b-tol").value, settleS: +$("#b-settle").value };
  spec.acceptance = { minScoreBps: +$("#b-min").value, maxDurationS: +$("#b-dur").value, targetEpisodes: +$("#b-target").value };
  curatorBps = +$("#b-bps").value;

  spec.world.objects = [...document.querySelectorAll(".bobj")].map((el) => {
    const g = (f) => el.querySelector(`[data-f="${f}"]`);
    const o = {
      category: g("category").value.trim(),
      instances: g("instances").value.split(",").map((s) => s.trim()).filter(Boolean),
      x: [+g("x0").value, +g("x1").value],
      y: [+g("y0").value, +g("y1").value],
    };
    const yaw = [+g("yaw0").value, +g("yaw1").value];
    if (yaw[0] || yaw[1]) o.yaw = yaw;
    const c = [+g("c0").value, +g("c1").value];
    if (c[0] !== 1 || c[1] !== 1) o.count = c;
    return o;
  });
}

function writeForm() {
  $("#b-instr").value = spec.instruction;
  $("#b-base").value = spec.world.base;
  $("#b-li0").value = spec.world.lightingIntensity[0];
  $("#b-li1").value = spec.world.lightingIntensity[1];
  $("#b-lk0").value = spec.world.lightingTemperatureK[0];
  $("#b-lk1").value = spec.world.lightingTemperatureK[1];
  $("#b-pred").value = spec.success.predicate;
  $("#b-tol").value = spec.success.toleranceMm;
  $("#b-settle").value = spec.success.settleS;
  $("#b-min").value = spec.acceptance.minScoreBps;
  $("#b-dur").value = spec.acceptance.maxDurationS;
  $("#b-target").value = spec.acceptance.targetEpisodes;
  $("#b-bps").value = curatorBps;
}

/* ------------------------------------------------------------------ output */

function refresh() {
  const issues = validateTaskSpec(spec);
  const host = $("#b-issues");
  host.innerHTML = issues.length === 0
    ? `<div class="bissue ok">This task is well formed and varies between episodes.</div>`
    : issues.map((i) => `<div class="bissue ${i.severity}">${i.message}</div>`).join("");

  const errored = issues.some((i) => i.severity === "error");
  const id = errored ? null : taskId(spec);
  $("#b-id").textContent = id ?? "— fix the errors above";
  $("#b-publish").disabled = errored;

  const cv = $("#b-scene");
  if (!errored) {
    const scene = sampleScene(spec, id, seed);
    drawScene(cv, scene, spec);
    $("#b-seed").textContent = `seed ${seed} · ${scene.objects.length} object${scene.objects.length === 1 ? "" : "s"}`;
  } else {
    cv.getContext("2d").clearRect(0, 0, cv.width, cv.height);
    $("#b-seed").textContent = "";
  }
}

const update = () => { readForm(); refresh(); };

/* ------------------------------------------- dragging the envelopes, on canvas */

function canvasToWorld(cv, ev) {
  const r = cv.getBoundingClientRect();
  let lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
  for (const o of spec.world.objects) {
    lo = [Math.min(lo[0], o.x[0]), Math.min(lo[1], o.y[0])];
    hi = [Math.max(hi[0], o.x[1]), Math.max(hi[1], o.y[1])];
  }
  if (!isFinite(lo[0])) return null;
  const padX = Math.max(0.08, (hi[0] - lo[0]) * 0.16), padY = Math.max(0.08, (hi[1] - lo[1]) * 0.16);
  lo = [lo[0] - padX, lo[1] - padY]; hi = [hi[0] + padX, hi[1] + padY];
  const s = Math.min(r.width / (hi[0] - lo[0]), r.height / (hi[1] - lo[1]));
  const ox = (r.width - (hi[0] - lo[0]) * s) / 2, oy = (r.height - (hi[1] - lo[1]) * s) / 2;
  return {
    x: lo[0] + (ev.clientX - r.left - ox) / s,
    y: lo[1] + (r.height - (ev.clientY - r.top) - oy) / s,
    perPx: 1 / s,
  };
}

function hitEnvelope(w) {
  // Nearest envelope whose box contains the point, with a small edge band so a
  // drag near a boundary resizes rather than moves.
  for (let i = spec.world.objects.length - 1; i >= 0; i--) {
    const o = spec.world.objects[i];
    const pad = w.perPx * 10;
    if (w.x < o.x[0] - pad || w.x > o.x[1] + pad || w.y < o.y[0] - pad || w.y > o.y[1] + pad) continue;
    const nearX0 = Math.abs(w.x - o.x[0]) < pad, nearX1 = Math.abs(w.x - o.x[1]) < pad;
    const nearY0 = Math.abs(w.y - o.y[0]) < pad, nearY1 = Math.abs(w.y - o.y[1]) < pad;
    if (nearX0 || nearX1 || nearY0 || nearY1) {
      return { i, mode: "resize", edge: { x0: nearX0, x1: nearX1, y0: nearY0, y1: nearY1 } };
    }
    return { i, mode: "move" };
  }
  return null;
}

function mountDrag() {
  const cv = $("#b-scene");
  let drag = null;
  cv.addEventListener("pointerdown", (e) => {
    const w = canvasToWorld(cv, e);
    if (!w) return;
    const hit = hitEnvelope(w);
    if (!hit) return;
    drag = { ...hit, from: w, start: JSON.parse(JSON.stringify(spec.world.objects[hit.i])) };
    cv.setPointerCapture(e.pointerId);
    cv.classList.add("dragging");
  });
  cv.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const w = canvasToWorld(cv, e);
    if (!w) return;
    const dx = w.x - drag.from.x, dy = w.y - drag.from.y;
    const o = spec.world.objects[drag.i], s = drag.start;
    if (drag.mode === "move") {
      o.x = [s.x[0] + dx, s.x[1] + dx];
      o.y = [s.y[0] + dy, s.y[1] + dy];
    } else {
      o.x = [drag.edge.x0 ? Math.min(s.x[0] + dx, s.x[1]) : s.x[0],
             drag.edge.x1 ? Math.max(s.x[1] + dx, s.x[0]) : s.x[1]];
      o.y = [drag.edge.y0 ? Math.min(s.y[0] + dy, s.y[1]) : s.y[0],
             drag.edge.y1 ? Math.max(s.y[1] + dy, s.y[0]) : s.y[1]];
    }
    o.x = o.x.map((v) => +v.toFixed(4));
    o.y = o.y.map((v) => +v.toFixed(4));
    renderObjects();
    refresh();
  });
  const end = (e) => {
    if (!drag) return;
    drag = null;
    cv.classList.remove("dragging");
    if (cv.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
  };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
}

/* ----------------------------------------------------------------- publish */

async function publish() {
  const status = $("#b-status");
  const eth = window.ethereum;
  if (!eth) {
    status.textContent = "No wallet in this browser. The spec is copyable, and `pnpm tsx scripts/publish-task.mjs` publishes it from the command line.";
    return;
  }
  try {
    status.textContent = "Asking your wallet…";
    const [from] = await eth.request({ method: "eth_requestAccounts" });
    const chainId = await eth.request({ method: "eth_chainId" });
    if (parseInt(chainId, 16) !== MONAD.chainId) {
      status.textContent = `Switch to ${MONAD.name} (chain ${MONAD.chainId}) and try again.`;
      return;
    }
    const id = taskId(spec);
    const uri = `https://thenar.io/tasks/${id.slice(2, 12)}`;
    const data = encodePublish(id, uri, curatorBps, spec.acceptance.targetEpisodes);
    const tx = await eth.request({
      method: "eth_sendTransaction",
      params: [{ from, to: MONAD.registry, data }],
    });
    status.innerHTML = `Published. <a href="${MONAD.explorer}/tx/${tx}" style="color:#8E6BFF">${tx.slice(0, 14)}…</a>`;
  } catch (e) {
    status.textContent = e.message?.includes("User denied")
      ? "You rejected the transaction, so nothing was published."
      : `Could not publish: ${e.message}`;
  }
}

/** publish(bytes32,string,uint16,uint32) — encoded by hand, no web3 bundle. */
function encodePublish(specHash, uri, bps, target) {
  const pad = (n) => BigInt(n).toString(16).padStart(64, "0");
  const bytes = new TextEncoder().encode(uri);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const padded = hex.padEnd(Math.ceil(bytes.length / 32) * 64, "0");
  // cast sig "publish(bytes32,string,uint16,uint32)"
  return "0x51038eb3"
    + specHash.replace(/^0x/, "")
    + pad(4 * 32)
    + pad(bps)
    + pad(target)
    + pad(bytes.length) + padded;
}

/* -------------------------------------------------------------------- boot */

fillEmbodiments();
writeForm();
renderObjects();
embodimentHint();
refresh();
mountDrag();

$("#b-predbuilder").innerHTML = PREDICATES.map((p) =>
  `<button type="button" data-p="${p}">${p}()</button>`).join("");
$("#b-predbuilder").addEventListener("click", (e) => {
  const p = e.target.dataset?.p;
  if (!p) return;
  const f = $("#b-pred");
  f.value = f.value.trim() ? `${f.value.trim()} && ${p}()` : `${p}()`;
  f.focus();
  update();
});

document.addEventListener("input", (e) => {
  if (e.target.closest(".bform")) { update(); if (e.target.id === "b-emb") embodimentHint(); }
});
document.addEventListener("change", (e) => {
  if (e.target.id === "b-emb") { readForm(); embodimentHint(); refresh(); }
});
$("#b-objects").addEventListener("click", (e) => {
  const i = e.target.dataset?.remove;
  if (i === undefined) return;
  spec.world.objects.splice(+i, 1);
  renderObjects(); refresh();
});
$("#b-add").addEventListener("click", () => {
  spec.world.objects.push({ category: "distractor", instances: ["can", "box"], x: [0.1, 0.5], y: [-0.3, 0.3], count: [0, 2] });
  renderObjects(); refresh();
});
$("#b-reroll").addEventListener("click", () => { seed = (seed + 1n) % (1n << 64n); refresh(); });
$("#b-publish").addEventListener("click", publish);
$("#b-copy").addEventListener("click", async () => {
  const text = JSON.stringify(spec, null, 2);
  try { await navigator.clipboard.writeText(text); $("#b-status").textContent = "Spec copied."; }
  catch { $("#b-status").textContent = "Clipboard is blocked here; the spec is in the task id panel."; }
});

export { spec, refresh, encodePublish };
