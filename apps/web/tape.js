/* tape.js — the ledger tape and the chain chip on `/`.
 *
 * Both read the same live `readAnchors()` call from `grasp-chain.js` so the
 * nav chip and the tape agree without a second RPC round trip. If the read
 * fails the tape says so in `.muted` rather than drawing invented stubs
 * (DESIGN.md §3, `.tape`); the chip flips to `unreachable`.
 */
import { CHAIN, readAnchors } from "./grasp-chain.js";

function shortHash(hex) {
  return hex.slice(0, 10) + "…" + hex.slice(-6);
}

const ZERO32 = "0x" + "0".repeat(64);

function renderStubs(tape, anchors) {
  tape.innerHTML = "";
  anchors.forEach((a, i) => {
    const isHead = i === anchors.length - 1;
    const stub = document.createElement("div");
    stub.className = "stub" + (isHead ? " head" : "");
    stub.dataset.withdrawal = a.revocationRoot !== ZERO32 ? "1" : "0";

    if (isHead) {
      const seal = document.createElement("span");
      seal.className = "seal";
      seal.setAttribute("data-label", "anchored");
      seal.setAttribute("aria-hidden", "true");
      stub.appendChild(seal);
    }

    const n = document.createElement("div");
    n.className = "n";
    n.textContent = String(a.size);

    const root = document.createElement("div");
    root.className = "root";
    root.textContent = shortHash(a.root);

    const blk = document.createElement("div");
    blk.className = "blk";
    blk.textContent = `block ${a.blockNumber}`;

    stub.append(n, root, blk);
    tape.appendChild(stub);
  });
}

function renderUnreachable(tape) {
  tape.innerHTML = "";
  const p = document.createElement("p");
  p.className = "muted";
  p.textContent = `Could not reach ${CHAIN.name}. Nothing is drawn.`;
  tape.appendChild(p);
}

function setChip(chip, state, text) {
  if (!chip) return;
  chip.dataset.state = state;
  chip.textContent = text;
}

function agoText(at) {
  // GraspLog's `at` is a Solidity block timestamp, in seconds; normalise in
  // case a future source (or a fixture) hands this milliseconds instead.
  const ms = at < 1e12 ? at * 1000 : at;
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

function renderReadout(readout, count, head) {
  if (!readout) return;
  readout.textContent = `Read from GraspLog ${shortHash(CHAIN.log)} on `
    + `${CHAIN.name} · ${count} anchor${count === 1 ? "" : "s"} · `
    + `head size ${head.size} · block ${head.blockNumber} · ${agoText(head.at)}`;
}

function fillHash(el, addr) {
  if (!el) return;
  el.textContent = addr;
}

/**
 * Mount the tape, the nav chain chip and the footer contract addresses.
 * `els.tape` and `els.chip` are required; `els.footer` is an optional
 * `{ log, verifier, registry }` map of elements to fill with the primary
 * chain's addresses (kept out of the HTML source so the copy guard's
 * no-hardcoded-address rule holds).
 */
export async function mountTape(els) {
  const { tape, chip, footer, readout } = els;
  if (footer) {
    fillHash(footer.log, `GraspLog ${CHAIN.log}`);
    fillHash(footer.verifier, `LeafVerifier ${CHAIN.verifier}`);
    fillHash(footer.registry, `LicenceRegistry ${CHAIN.registry}`);
  }

  setChip(chip, "loading", "connecting…");

  try {
    const { count, anchors } = await readAnchors(10);
    if (!anchors.length) throw new Error("no anchors");
    renderStubs(tape, anchors);
    setChip(chip, "ok", `${CHAIN.name} · ${count} anchor${count === 1 ? "" : "s"}`);
    renderReadout(readout, count, anchors[anchors.length - 1]);
  } catch {
    renderUnreachable(tape);
    setChip(chip, "unreachable", `${CHAIN.name} · unreachable`);
    if (readout) readout.textContent = "";
  }
}
