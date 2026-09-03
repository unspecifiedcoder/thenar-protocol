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
import { CHAIN, readCorpusCount, readCorpusAt, readTerms, LICENCE_SELECTORS } from "./grasp-chain.js";

const $ = (s, r = document) => r.querySelector(s);
const short = (h) => (h.length > 18 ? h.slice(0, 10) + "…" + h.slice(-6) : h);

/** Overridable so a preview deploy or a test can point this page at a different log service without a bundler. */
export const API_BASE =
  (typeof window !== "undefined" && (new URLSearchParams(location.search).get("api") || window.THENAR_API_BASE))
  || "https://api.thenar.io";

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

const fmtAmount = (amount, decimals = 6) => {
  const n = BigInt(amount);
  const base = 10n ** BigInt(decimals);
  const whole = n / base, frac = n % base;
  const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
  return fracStr ? `${whole}.${fracStr}` : `${whole}`;
};

// ============================================================ list view

function card(c) {
  const el = document.createElement("article");
  el.className = "card";
  el.innerHTML = `
    <div class="chead">
      <h2 class="ctitle"><a href="./corpus.html?id=${c.id}">Corpus #${c.id}</a></h2>
      <span class="cmeta">${c.open ? "open to licence" : "closed"}</span>
    </div>
    <div class="figs">
      <div class="fig"><div class="k">Episodes</div><div class="v">${c.episodeCount}</div></div>
      <div class="fig"><div class="k">Price</div><div class="v small">${fmtAmount(c.price)} <span class="mono">${short(c.token)}</span></div></div>
      <div class="fig"><div class="k">Supplier</div><div class="v small">${copyBtn(c.supplier)}</div></div>
    </div>
    <div class="fig" style="margin-top:6px">
      <div class="k">Corpus root</div>
      <div class="v small">${copyBtn(c.corpusRoot)}</div>
    </div>`;
  wireCopy(el);
  return el;
}

/** Exported so the empty and populated list states can be tested without a chain. */
export function render(host, corpora) {
  host.innerHTML = "";
  if (corpora.length === 0) {
    host.innerHTML = `<div class="cempty" data-state="empty">No corpus has been sealed yet.
      A corpus appears here once its manifest leaf is logged, anchored, and <code>sealCorpus</code> runs.</div>`;
    return;
  }
  for (const c of corpora) host.appendChild(card(c));
}

export function renderError(host, message) {
  host.innerHTML = `<div class="cempty" data-state="error">
    Could not reach the chain, so nothing is shown rather than guessed. ${message}</div>`;
}

export async function loadList(host) {
  try {
    const n = await readCorpusCount();
    const corpora = [];
    for (let i = 0; i < n; i++) corpora.push(await readCorpusAt(i));
    render(host, corpora);
  } catch (e) {
    renderError(host, e.message);
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
    return "Sources — unknown (pre-v2.2 corpus).";
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

function calldataBlock(label, target, data) {
  return `<div class="calldata-row">
    <div class="k">${label} — target ${copyBtn(target)}, selector <span class="mono">${data.slice(0, 10)}</span></div>
    <pre class="mono calldata">${data}</pre>
  </div>`;
}

function renderDetail(host, record) {
  host.innerHTML = "";
  const el = document.createElement("article");
  el.className = "card";

  const idLabel = record.offChainId ? `Corpus ${record.offChainId}` : `Corpus #${record.onChain?.id ?? "?"}`;
  const revokedNote = record.containsRevoked === true
    ? `<p class="cmeta" style="color:#FA9DCD">Contains a revoked episode — see §6.1: existing receipts still verify against their sealing anchor, but a new buyer is shown this before paying.</p>`
    : record.containsRevoked === false
      ? `<p class="cmeta">No revoked episode in this corpus, as of the last check.</p>`
      : `<p class="cmeta">Revocation status unknown — the log service has no off-chain row for this id.</p>`;

  el.innerHTML = `
    <div class="chead"><h1 class="ctitle">${idLabel}</h1>
      <span class="cmeta">${record.onChain ? (record.onChain.open ? "open to licence" : "closed") : "not sealed on chain yet"}</span>
    </div>
    <div class="fig" style="margin-top:10px"><div class="k">Corpus manifest hash</div><div class="v small">${copyBtn(record.corpusManifestHash)}</div></div>
    <div class="fig" style="margin-top:6px"><div class="k">Corpus root</div><div class="v small">${copyBtn(record.corpusRoot)}</div></div>
    ${revokedNote}
    <p class="cmeta">${sourcesLine(record.manifest)}</p>
    <div id="onchain-section"></div>
    <div id="terms-section"></div>
    <div id="purchase-section"></div>`;

  const onchainSection = $("#onchain-section", el);
  if (record.onChain) {
    onchainSection.innerHTML = `
      <div class="figs" style="margin-top:14px">
        <div class="fig"><div class="k">Terms hash</div><div class="v small">${copyBtn(record.onChain.termsHash)}</div></div>
        <div class="fig"><div class="k">Price</div><div class="v small">${fmtAmount(record.onChain.price)} <span class="mono">${short(record.onChain.token)}</span></div></div>
        <div class="fig"><div class="k">Episodes</div><div class="v">${record.onChain.episodeCount}</div></div>
      </div>`;
  } else {
    onchainSection.innerHTML = `<p class="cmeta" style="margin-top:14px">Not yet sealed on chain — no price, token or purchase calldata to show yet.</p>`;
  }

  const termsSection = $("#terms-section", el);
  const purchaseSection = $("#purchase-section", el);

  if (record.onChain) {
    (async () => {
      let terms = null;
      try { terms = await readTerms(record.onChain.termsHash); } catch { /* rendered as "not published" below */ }
      termsSection.innerHTML = terms
        ? `<p class="cmeta" style="margin-top:14px">Terms <span class="mono">${short(record.onChain.termsHash)}</span> — <a href="${terms.uri}" rel="noreferrer">${terms.uri}</a>${terms.retired ? " (retired)" : ""}</p>`
        : `<p class="cmeta" style="margin-top:14px">These terms are not published on this chain yet.</p>`;

      const gate = document.createElement("label");
      gate.className = "cmeta";
      gate.style.cssText = "display:flex;align-items:center;gap:8px;margin-top:16px";
      gate.innerHTML = `<input type="checkbox" id="terms-read"> I have read terms ${record.onChain.termsHash}`;
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
          calldataHost.innerHTML = `<p class="cmeta">No LicenceRegistry address configured for the primary chain — cannot compute purchase calldata.</p>`;
          return;
        }
        const approveData = approveCalldata(registry, record.onChain.price);
        const licenseData = licenseCalldata(record.onChain.id);
        calldataHost.innerHTML =
          calldataBlock("approve", record.onChain.token, approveData) +
          calldataBlock("license", registry, licenseData) +
          `<div class="actions">
            <button class="btn sm" id="send-approve">Send approve via wallet</button>
            <button class="btn sm ghost" id="send-license">Send license via wallet</button>
          </div>
          <p class="cmeta" id="wallet-status" style="margin-top:8px"></p>
          <p class="cmeta" style="margin-top:8px">No private key is ever asked for on this page — every send goes through your own injected wallet.</p>`;
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
  } else {
    termsSection.innerHTML = "";
  }

  wireCopy(el);
  host.appendChild(el);
}

export async function loadDetail(host, id) {
  try {
    const record = await loadCorpus(id);
    renderDetail(host, record);
  } catch (e) {
    renderError(host, e.message);
  }
}

// ============================================================ entry point

const host = $("#corpora");
if (host) {
  const id = new URLSearchParams(location.search).get("id");
  if (id) loadDetail(host, id);
  else loadList(host);
}
