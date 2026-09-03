/* corpus.js — list + detail (?id=), the buyer's path (T-027, PLAN §21 steps 4-6).
 *
 * The list enumerates sealed corpora straight off `LicenceRegistry`
 * (`corpusCount`/`corpusAt`, D-29 — no indexer) since there is no `GET
 * /corpora` in PLAN §12; each card links to the detail view by that
 * on-chain id. The detail view tries the log service first — `GET
 * /v1/corpora/{id}` names things the chain alone cannot: `contains_revoked`
 * (§6.1), the `Sources —` line (§1.1), the manifest itself — and only falls
 * back to a chain-only id when the log service does not know this id (a
 * corpus this page was linked to straight from the list, before the log
 * service ever learned its on-chain id back — T-027's supervisor note).
 * Numbers are shown or absent, never guessed (I-11).
 */
import { CHAIN, readCorpusCount, readCorpusAt, readTerms, readTokenSymbol, LICENCE_SELECTORS } from "./grasp-chain.js";

/** True for every chain this page is likely to run against today (T-041c:
 * a resolved token symbol is annotated "(mock, testnet)" rather than shown
 * as if it settled real value). */
const IS_TESTNET = /test|fuji|sepolia|goerli/i.test(CHAIN?.name || "");

/** `{amount} {symbol}` for a price cell — resolves the ERC-20 symbol via
 * `readTokenSymbol`, falling back to the short address if the call fails. */
async function tokenLabel(token) {
  const symbol = await readTokenSymbol(token).catch(() => null);
  return symbol ? `${symbol}${IS_TESTNET ? " (mock, testnet)" : ""}` : short(token);
}

const $ = (s, r = document) => r.querySelector(s);
const short = (h) => (h.length > 18 ? h.slice(0, 10) + "…" + h.slice(-6) : h);

/** Overridable so a preview deploy or a test can point this page at a different log service without a bundler. */
export const API_BASE =
  (typeof window !== "undefined" && (new URLSearchParams(location.search).get("api") || window.THENAR_API_BASE))
  || "https://api.thenar.io";

/** Wires every `.copy-btn` under `root` (design.css `.copy`): click copies
 * its `data-copy` value, shows "Copied" for 1.2 s (`data-done="1"` per
 * design.css), falls back to a selectable span when the clipboard API is
 * unavailable or blocked. */
function wireCopy(root) {
  for (const b of root.querySelectorAll(".copy-btn")) {
    b.addEventListener("click", async () => {
      const v = b.dataset.copy;
      try {
        await navigator.clipboard.writeText(v);
        const was = b.textContent;
        b.textContent = "Copied";
        b.dataset.done = "1";
        setTimeout(() => { b.textContent = was; delete b.dataset.done; }, 1200);
      } catch {
        const holder = document.createElement("span");
        holder.className = "hash";
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

/** A `.hash-short` value with a "Copy" affordance (design.css `.copy`). */
const copyBtn = (v, label = "Copy") =>
  `<span class="copy"><span class="hash-short" title="${v}">${short(v)}</span><button class="copy-btn" data-copy="${v}">${label}</button></span>`;

const fmtAmount = (amount, decimals = 6) => {
  const n = BigInt(amount);
  const base = 10n ** BigInt(decimals);
  const whole = n / base, frac = n % base;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
};

// ============================================================ list view

/** The list's `Sources —` cell: the chain-only enumeration (`corpusAt`) carries
 * no manifest, so every row shows the short, pre-v2.2 form of `sourcesLine`
 * (PLAN §1.1) rather than one fetch per row against the log service. */
function listSourcesLine() {
  return sourcesLine(null);
}

function row(c) {
  const sealed = c.anchorSize > 0;
  const tr = document.createElement("tr");
  if (sealed) tr.className = "anchored";
  tr.innerHTML = `
    <td><a href="./corpus.html?id=${c.id}">Corpus #${c.id}</a>
      <div class="small" style="color:var(--ink-2)">${c.open ? "open to licence" : "closed"}</div></td>
    <td class="num">${c.episodeCount}</td>
    <td class="small">${listSourcesLine()}</td>
    <td class="num">${fmtAmount(c.price)} <span class="token-label">${short(c.token)}</span></td>
    <td>${sealed ? '<span class="seal" title="sealed and anchored"></span> sealed' : "logged"}</td>`;
  // The token symbol needs a chain read; the row shows the short address
  // until it resolves (or forever, if the token does not answer `symbol()`).
  tokenLabel(c.token).then((label) => {
    const el = tr.querySelector(".token-label");
    if (el) el.textContent = label;
  }).catch(() => {});
  return tr;
}

/** Exported so the empty and populated list states can be tested without a chain. */
export function render(host, corpora) {
  host.innerHTML = "";
  if (corpora.length === 0) {
    host.innerHTML = `<div class="empty" data-state="empty">No corpus has been sealed yet — a
      corpus appears here once its manifest leaf is logged, anchored, and
      <code class="hash">sealCorpus</code> runs. Seal one with
      <code class="hash">scripts/seal-corpus.mjs</code>.</div>`;
    return;
  }
  const wrap = document.createElement("div");
  wrap.className = "register-wrap";
  const table = document.createElement("table");
  table.className = "register";
  table.innerHTML = `<thead><tr>
      <th>Corpus</th><th class="num">Episodes</th><th>Sources</th><th class="num">Price</th><th>Status</th>
    </tr></thead><tbody></tbody>`;
  const tbody = table.querySelector("tbody");
  for (const c of corpora) tbody.appendChild(row(c));
  wrap.appendChild(table);
  host.appendChild(wrap);
}

export function renderError(host, message) {
  host.innerHTML = `<div class="notice" data-kind="fail">
    Could not reach the chain, so nothing is shown rather than guessed. ${message}</div>`;
}

/** `statsHost` (optional) gets the live-read summary line DESIGN §4 calls
 * for — "{n} corpora sealed on {chain}, read {t}s ago" — set once the read
 * that filled the register has completed. */
export async function loadList(host, statsHost) {
  const t0 = Date.now();
  try {
    const n = await readCorpusCount();
    const corpora = [];
    for (let i = 0; i < n; i++) corpora.push(await readCorpusAt(i));
    render(host, corpora);
    if (statsHost) {
      const t = Math.max(0, Math.round((Date.now() - t0) / 1000));
      const chainName = CHAIN?.name ?? "this chain";
      statsHost.textContent = `${n} ${n === 1 ? "corpus" : "corpora"} sealed on ${chainName}, read ${t}s ago.`;
    }
  } catch (e) {
    renderError(host, e.message);
    if (statsHost) statsHost.textContent = "";
  }
}

// ============================================================ detail view

/** Normalises the log service's `GET /v1/corpora/{id}` body into the shape `renderDetail` reads. */
function fromApi(body) {
  const onChainLive = body.on_chain && body.on_chain.unreachable !== true ? body.on_chain : null;
  return {
    offChainId: body.corpus_id,
    manifest: body.manifest ?? null,
    corpusManifestHash: body.corpus_manifest_hash,
    corpusRoot: body.corpus_root,
    containsRevoked: body.contains_revoked ?? null,
    onChain: onChainLive
      ? {
          id: body.on_chain_id, termsHash: onChainLive.termsHash, episodeCount: onChainLive.episodeCount,
          supplier: onChainLive.supplier, price: onChainLive.price, token: onChainLive.token,
          open: onChainLive.open, sealedAt: onChainLive.sealedAt,
        }
      : null,
  };
}

/** A chain-only record (`readCorpusAt`) — used when the log service has no row for this id, or is unreachable. */
function fromChain(id, c) {
  return {
    offChainId: null,
    manifest: null,
    corpusManifestHash: c.corpusManifestHash,
    corpusRoot: c.corpusRoot,
    containsRevoked: null,
    onChain: c,
  };
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) return { ok: false, status: res.status };
  return { ok: true, body: await res.json() };
}

/** Exported for the test: fetches and normalises one corpus by the `?id=` on the page, without touching the DOM. */
export async function loadCorpus(id) {
  const off = await fetchJson(`${API_BASE.replace(/\/$/, "")}/v1/corpora/${encodeURIComponent(id)}`).catch(() => ({ ok: false }));
  if (off.ok) {
    const record = fromApi(off.body);
    if (!record.onChain) {
      const onchain = await fetchJson(`${API_BASE.replace(/\/$/, "")}/v1/corpora/${encodeURIComponent(id)}/onchain`).catch(() => ({ ok: false }));
      if (onchain.ok && onchain.body.on_chain_id !== undefined) {
        record.onChain = { id: onchain.body.on_chain_id, ...onchain.body.corpus };
      }
    }
    return record;
  }
  if (/^\d+$/.test(String(id))) {
    const c = await readCorpusAt(Number(id));
    return fromChain(id, c);
  }
  throw new Error(`no corpus ${id} — not known to the log service, and not a numeric on-chain id`);
}

/** PLAN §1.1: the corpus `Sources —` line, verbatim; a manifest logged before the source axis shipped carries no `sources` field. */
function sourcesLine(manifest) {
  if (!manifest || !Array.isArray(manifest.sources) || manifest.sources.length === 0) {
    return "Sources — not recorded for this corpus.";
  }
  return `Sources — ${manifest.sources.join(", ")}.`;
}

const addrArg = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const uintArg = (n) => BigInt(n).toString(16).padStart(64, "0");

function approveCalldata(spender, amount) {
  return LICENCE_SELECTORS.approve + addrArg(spender) + uintArg(amount);
}
function licenseCalldata(corpusId) {
  return LICENCE_SELECTORS.license + uintArg(corpusId);
}

async function sendViaWallet(to, data) {
  if (!window.ethereum) throw new Error("no injected wallet found (window.ethereum)");
  const accounts = await window.ethereum.request({ method: "eth_requestAccounts" });
  const from = accounts[0];
  if (CHAIN?.id) {
    await window.ethereum.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: "0x" + CHAIN.id.toString(16) }],
    }).catch(() => { /* the wallet may already be on this chain, or refuse the switch — the send below still names it */ });
  }
  return window.ethereum.request({ method: "eth_sendTransaction", params: [{ from, to, data }] });
}

/** One `.evidence` block (design.css): the calldata itself in `.calldata`
 * (its `textContent` is exactly the hex string — nothing else — since a
 * buyer or a test may copy/compare it verbatim), a "Copy calldata" button. */
function evidenceBlock(label, target, data) {
  return `<div class="evidence">
    <div class="k small">${label} — target ${copyBtn(target)}, selector <span class="hash-short">${data.slice(0, 10)}</span></div>
    <pre class="hash calldata">${data}</pre>
    <span class="copy" style="margin-top:8px"><button class="copy-btn" data-copy="${data}">Copy calldata</button></span>
  </div>`;
}

function renderDetail(host, record, requestedId) {
  host.innerHTML = "";
  const el = document.createElement("article");
  el.className = "record";

  const idLabel = record.offChainId ? `Corpus ${record.offChainId}` : `Corpus #${record.onChain?.id ?? "?"}`;
  const statusLabel = record.onChain ? (record.onChain.open ? "open to licence" : "closed") : "not sealed on chain yet";
  const revokedNote = record.containsRevoked === true
    ? `<div class="notice" data-kind="warn">Contains a revoked episode — see §6.1: existing receipts still verify against their sealing anchor, but a new buyer is shown this before paying.</div>`
    : record.containsRevoked === false
      ? `<p class="small" style="color:var(--ink-2)">No revoked episode in this corpus, as of the last check.</p>`
      : `<p class="small" style="color:var(--ink-2)">Revocation status unknown — the log service has no off-chain row for this id.</p>`;

  const reportId = record.offChainId ?? requestedId;
  const reportBase = `${API_BASE.replace(/\/$/, "")}/v1/corpora/${encodeURIComponent(reportId)}/report`;
  const reportActions = record.offChainId
    ? `<div class="report-actions">
        <a class="btn" href="${reportBase}" target="_blank" rel="noreferrer">Read the report</a>
        <a class="btn btn-quiet" href="${reportBase}?format=pdf" target="_blank" rel="noreferrer">Download report (PDF)</a>
      </div>`
    : "";

  el.innerHTML = `
    <h2>${idLabel} <span class="status">${statusLabel}</span></h2>
    <dl class="deflist" id="deflist"></dl>
    ${revokedNote}
    <p class="source" data-attested="0">${sourcesLine(record.manifest)}</p>
    ${reportActions}
    <div id="purchase-section"></div>`;

  const deflist = $("#deflist", el);
  deflist.innerHTML =
    `<dt>Corpus manifest hash</dt><dd>${copyBtn(record.corpusManifestHash)}</dd>` +
    `<dt>Corpus root</dt><dd>${copyBtn(record.corpusRoot)}</dd>`;
  if (record.onChain) {
    deflist.innerHTML +=
      `<dt>Terms hash</dt><dd>${copyBtn(record.onChain.termsHash)}</dd>` +
      `<dt>Price</dt><dd>${fmtAmount(record.onChain.price)} <span class="token-label">${short(record.onChain.token)}</span> — ${copyBtn(record.onChain.token)}</dd>` +
      `<dt>Episodes</dt><dd>${record.onChain.episodeCount}</dd>` +
      `<dt>On-chain id</dt><dd>${record.onChain.id}</dd>` +
      `<dt>Sealing anchor</dt><dd>(${copyBtn(record.onChain.anchorRoot ?? record.corpusRoot)}, size ${record.onChain.anchorSize ?? "—"})</dd>`;
    tokenLabel(record.onChain.token).then((label) => {
      const el2 = $(".token-label", deflist);
      if (el2) el2.textContent = label;
    }).catch(() => {});
  }

  const purchaseSection = $("#purchase-section", el);

  if (record.onChain) {
    (async () => {
      let terms = null;
      try { terms = await readTerms(record.onChain.termsHash); } catch { /* rendered as "not published" below */ }
      const termsNote = document.createElement("p");
      termsNote.className = "small";
      termsNote.style.cssText = "color:var(--ink-2);margin-bottom:16px";
      termsNote.innerHTML = terms
        ? `Terms ${copyBtn(record.onChain.termsHash)} — <a href="${terms.uri}" rel="noreferrer">${terms.uri}</a>${terms.retired ? " (retired)" : ""}`
        : "These terms are not published on this chain yet.";
      purchaseSection.appendChild(termsNote);

      const gate = document.createElement("label");
      gate.className = "terms-gate";
      gate.innerHTML = `<input type="checkbox" id="terms-read"> I have read terms <span class="hash-short">${short(record.onChain.termsHash)}</span>`;
      purchaseSection.appendChild(gate);

      const calldataHost = document.createElement("div");
      calldataHost.hidden = true;
      calldataHost.className = "calldata-host";
      purchaseSection.appendChild(calldataHost);

      $("#terms-read", gate).addEventListener("change", (ev) => {
        calldataHost.hidden = !ev.target.checked;
        if (!ev.target.checked || calldataHost.dataset.rendered) return;
        calldataHost.dataset.rendered = "1";
        const registry = CHAIN?.registry;
        if (!registry) {
          calldataHost.innerHTML = `<div class="notice" data-kind="warn">No LicenceRegistry address configured for the primary chain — cannot compute purchase calldata.</div>`;
          return;
        }
        const approveData = approveCalldata(registry, record.onChain.price);
        const licenseData = licenseCalldata(record.onChain.id);
        calldataHost.innerHTML =
          evidenceBlock("approve", record.onChain.token, approveData) +
          evidenceBlock("license", registry, licenseData) +
          `<div class="actions">
            <button class="btn btn-quiet" id="send-approve">Send approve via wallet</button>
            <button class="btn btn-seal" id="send-license">License with wallet</button>
          </div>
          <p class="small" id="wallet-status" style="margin-top:8px;color:var(--ink-2)"></p>
          <p class="small" style="margin-top:8px;color:var(--ink-2)">No private key is ever asked for on this page — every send goes through your own injected wallet.</p>`;
        wireCopy(calldataHost);
        const status = $("#wallet-status", calldataHost);
        $("#send-approve", calldataHost).addEventListener("click", async () => {
          try { status.textContent = `tx: ${await sendViaWallet(record.onChain.token, approveData)}`; }
          catch (e) { status.textContent = `error: ${e.message}`; }
        });
        $("#send-license", calldataHost).addEventListener("click", async () => {
          try { status.textContent = `tx: ${await sendViaWallet(registry, licenseData)}`; }
          catch (e) { status.textContent = `error: ${e.message}`; }
        });
      });
    })();
  }

  wireCopy(el);
  host.appendChild(el);
}

export async function loadDetail(host, id) {
  try {
    const record = await loadCorpus(id);
    renderDetail(host, record, id);
  } catch (e) {
    renderError(host, e.message);
  }
}

// ============================================================ entry point

const host = $("#corpora");
if (host) {
  const id = new URLSearchParams(location.search).get("id");
  if (id) loadDetail(host, id);
  else loadList(host, $("#corpus-stats"));
}
