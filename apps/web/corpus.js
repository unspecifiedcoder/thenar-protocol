/* corpus.js — the catalogue, read from the contract.
 *
 * Every figure here comes from a chain read. Where a number cannot be read it
 * is absent rather than guessed: a corpus page that invents a quality spread is
 * worse than one that says it has none yet.
 */
import { MONAD, readCorpora, readTasks, readReceiptCount } from "./grasp-chain.js";

const $ = (s, r = document) => r.querySelector(s);
const short = (h) => h.slice(0, 10) + "…" + h.slice(-6);
const mon = (wei) => {
  const s = (Number(wei) / 1e18).toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
  return s === "" ? "0" : s;
};

/** Copy that confirms, and puts the label back so the row does not stay green. */
function wireCopy(root) {
  for (const b of root.querySelectorAll(".copy")) {
    b.addEventListener("click", async () => {
      const v = b.dataset.copy;
      try {
        await navigator.clipboard.writeText(v);
        const was = b.textContent;
        b.textContent = "copied";
        b.classList.add("ok");
        setTimeout(() => { b.textContent = was; b.classList.remove("ok"); }, 1200);
      } catch {
        // Clipboard access is permission-gated and can be refused outright.
        // Telling somebody to press ⌘C without selecting anything is useless,
        // so put the value on the page and select it — then the instruction is
        // true and the keystroke actually copies.
        const holder = document.createElement("span");
        holder.className = "mono";
        holder.textContent = v;
        holder.style.cssText = "user-select:all;word-break:break-all";
        b.replaceWith(holder);
        const range = document.createRange();
        range.selectNodeContents(holder);
        const sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        holder.title = "Selected — press ⌘C to copy";
      }
    });
  }
}

const copyBtn = (v) => `<button class="copy mono" data-copy="${v}" title="${v}">${short(v)}</button>`;

/** A histogram of the committed quality weights — the spread a buyer filters on. */
function histogram(weights) {
  if (weights.length === 0) return "";
  const vals = weights.map(Number);
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const bins = 12;
  const counts = new Array(bins).fill(0);
  for (const v of vals) {
    const k = hi === lo ? 0 : Math.min(bins - 1, Math.floor(((v - lo) / (hi - lo)) * bins));
    counts[k]++;
  }
  const max = Math.max(...counts, 1);
  const peak = counts.indexOf(max);
  return `<div class="hist" role="img" aria-label="Quality spread across ${vals.length} contributors">` +
    counts.map((c, i) =>
      `<i class="${i === peak ? "hot" : ""}" style="height:${Math.max(3, (c / max) * 100)}%;animation-delay:${i * 26}ms"></i>`
    ).join("") + `</div>`;
}

/* The contract takes its fee and the curator's share off the top, then splits
   what is left by weight. Showing contributors receiving the whole fee would
   overstate what a contributor is actually paid. Read from the contract:
   PROTOCOL_BPS is 250. */
const PROTOCOL_BPS = 250n;

function contributorPool(price, curatorBps) {
  const p = BigInt(price);
  return p - (p * PROTOCOL_BPS) / 10000n - (p * BigInt(curatorBps)) / 10000n;
}

function capTable(c, curatorBps) {
  if (c.contributors.length === 0) return `<p class="cmeta">No contributors recorded.</p>`;
  const total = Number(c.weightTotal) || 1;
  const pool = contributorPool(c.price, curatorBps);
  const rows = c.contributors.map((a, i) => {
    const w = Number(c.weights[i]);
    const pct = (w / total) * 100;
    const share = (pool * BigInt(c.weights[i])) / BigInt(c.weightTotal || 1n);
    return `<tr>
      <td>${copyBtn(a)}</td>
      <td>${w.toLocaleString()}</td>
      <td>${pct.toFixed(2)}%</td>
      <td>${mon(share)} MON</td>
    </tr>`;
  }).join("");
  const bar = c.contributors.map((_, i) => {
    const pct = (Number(c.weights[i]) / total) * 100;
    const hue = 258 + (i * 26) % 60;
    return `<span style="width:${pct}%;background:hsl(${hue} 88% ${46 + (i % 3) * 9}%)"></span>`;
  }).join("");
  return `<div class="bar" role="img" aria-label="Cap table split">${bar}</div>
    <table class="captable">
      <thead><tr><th>Contributor</th><th>Weight</th><th>Share</th><th>Per licence</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function card(c, task, receipts) {
  const el = document.createElement("article");
  el.className = "card";
  const priced = c.token === "0x0000000000000000000000000000000000000000"
    ? `${mon(c.price)} MON` : `${mon(c.price)} (token)`;
  el.innerHTML = `
    <div class="chead">
      <h2 class="ctitle">Corpus #${c.index}</h2>
      <span class="cmeta">${c.open ? "open to licence" : "closed"}</span>
    </div>
    <p class="cmeta" style="margin:6px 0 0">
      task #${c.taskId}${task ? ` · curator ${copyBtn(task.curator)} · ${task.curatorBps / 100}% share` : ""}
    </p>
    <div class="figs">
      <div class="fig"><div class="k">Episodes covered</div><div class="v">${c.corpusSize}</div></div>
      <div class="fig"><div class="k">Contributors</div><div class="v">${c.contributors.length}</div></div>
      <div class="fig"><div class="k">Licence</div><div class="v">${priced}</div></div>
      <div class="fig"><div class="k">Licences sold</div><div class="v">${receipts}</div></div>
    </div>
    <div class="fig" style="margin-top:6px">
      <div class="k">Corpus root</div>
      <div class="v small">${copyBtn(c.corpusRoot)}</div>
    </div>
    <div style="margin-top:18px">
      <div class="k" style="font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:#6E6E6E">Quality spread</div>
      ${histogram(c.weights)}
    </div>
    <div style="margin-top:18px">
      <div class="k" style="font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:#6E6E6E">Where one licence fee goes</div>
      <table class="captable" style="margin-bottom:14px">
        <tbody>
          <tr><td>Protocol</td><td>2.50%</td><td>${mon((BigInt(c.price) * 250n) / 10000n)} MON</td></tr>
          <tr><td>Curator</td><td>${task ? (task.curatorBps / 100).toFixed(2) : "0.00"}%</td><td>${mon((BigInt(c.price) * BigInt(task ? task.curatorBps : 0)) / 10000n)} MON</td></tr>
          <tr><td>Contributors</td><td>${task ? ((10000 - 250 - task.curatorBps) / 100).toFixed(2) : "97.50"}%</td><td>${mon(contributorPool(c.price, task ? task.curatorBps : 0))} MON</td></tr>
        </tbody>
      </table>
      <div class="k" style="font-size:10.5px;letter-spacing:.07em;text-transform:uppercase;color:#6E6E6E">Split across contributors, by measured quality</div>
      ${capTable(c, task ? task.curatorBps : 0)}
    </div>
    <div class="actions">
      <a class="btn sm" href="./verify.html?anchor=&amp;corpus=${c.index}">Verify an episode</a>
      <a class="btn sm ghost" href="${MONAD.explorer}/address/${MONAD.market}">Market on the explorer</a>
    </div>`;
  wireCopy(el);
  return el;
}

/** Exported so the empty and populated states can be tested without a chain. */
export function render(host, corpora, tasks, receipts) {
  host.innerHTML = "";
  if (corpora.length === 0) {
    host.innerHTML = `<div class="cempty" data-state="empty">No corpus has been sealed yet.
      A corpus appears here once a task's accepted episodes are anchored and sealed.</div>`;
    return;
  }
  for (const c of corpora) {
    host.appendChild(card(c, tasks.find((t) => BigInt(t.index) === c.taskId), receipts));
  }
}

export function renderError(host, message) {
  host.innerHTML = `<div class="cempty" data-state="error">
    Could not reach Monad, so nothing is shown rather than guessed. ${message}</div>`;
}

export async function load(host) {
  try {
    const [corpora, tasks, receipts] = await Promise.all([readCorpora(), readTasks(), readReceiptCount()]);
    render(host, corpora, tasks, receipts);
  } catch (e) {
    renderError(host, e.message);
  }
}

const host = $("#corpora");
if (host) load(host);
