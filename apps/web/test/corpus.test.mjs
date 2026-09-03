/**
 * The corpus page's states — list and detail (T-027) — without a chain.
 *
 * The empty and error states are the two a reviewer is most likely to hit
 * and the two hardest to reach in a browser, because a real registry is
 * rarely empty and an RPC is rarely down on cue. The detail-view checks
 * mock `window.ethereum` (`eth_call`, `eth_requestAccounts`,
 * `wallet_switchEthereumChain`, `eth_sendTransaction`) rather than a live
 * wallet, per T-027's binding rule.
 */
import { JSDOM } from "jsdom";

let fails = 0;
const ok = (c, m, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };

const dom = new JSDOM(`<!doctype html><div id="corpora"></div>`, { url: "https://thenar.io/corpus.html" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.location = dom.window.location;
globalThis.URLSearchParams = dom.window.URLSearchParams;
// navigator is a getter-only global in modern Node, so define rather than assign.
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.getSelection = () => dom.window.getSelection();
globalThis.Element = dom.window.Element;
globalThis.fetch = async () => { throw new Error("no network in this test"); };

const { render, renderError, loadCorpus, loadDetail } = await import("../corpus.js");
const host = document.querySelector("#corpora");

// ============================================================ list states

render(host, []);
ok(/No corpus has been sealed yet/.test(host.textContent), "empty state says no corpus has been sealed");
ok(host.querySelector('.empty[data-state="empty"]'), "and marks itself as the empty state (design.css .empty)");
ok(host.querySelectorAll(".register tbody tr").length === 0, "and renders no rows");

renderError(host, "boom");
ok(host.querySelector('.notice[data-kind="fail"]'), "error state is marked (design.css .notice[data-kind=fail])");
ok(/nothing is shown rather than guessed/.test(host.textContent), "and says nothing is guessed");
ok(!/Corpus #/.test(host.textContent), "and shows no corpus");

const corpus = {
  id: 0, corpusManifestHash: "0x" + "cc".repeat(32), corpusRoot: "0x" + "ab".repeat(32),
  termsHash: "0x" + "dd".repeat(32), episodeCount: 40,
  supplier: "0x" + "11".repeat(20), price: 20000000n, token: "0x" + "22".repeat(20),
  open: true, sealedAt: 1756900000, anchorRoot: "0x" + "ee".repeat(32), anchorSize: 41,
};
render(host, [corpus]);
ok(host.querySelectorAll(".register tbody tr").length === 1, "a corpus renders one register row");
ok(host.querySelector("tr.anchored"), "a sealed-and-anchored corpus gets the .anchored row rule");
ok(host.querySelector('.register tr .seal'), "and shows the .seal mark in its status cell");
ok(host.querySelector('a[href="./corpus.html?id=0"]'), "the row links to the detail view by on-chain id");

// ============================================================ detail view

// `eth_call` is exercised only for `termsAt` here: `loadCorpus` reads the
// corpus itself from the mocked log-service `fetch` below (its `on_chain`
// is already embedded, so `readCorpusAt` never runs), matching the normal
// path once a corpus is both logged and sealed.
function encodeTermsAt(uri, publishedAt, retired, exists) {
  const strBytes = new TextEncoder().encode(uri);
  const paddedLen = Math.max(32, Math.ceil(strBytes.length / 32) * 32);
  let strHex = Array.from(strBytes, (b) => b.toString(16).padStart(2, "0")).join("");
  strHex = strHex.padEnd(paddedLen * 2, "0");
  const word = (n) => BigInt(n).toString(16).padStart(64, "0");
  return "0x" + word(4 * 32) + word(publishedAt) + word(retired ? 1 : 0) + word(exists ? 1 : 0) + word(strBytes.length) + strHex;
}

const sentTx = [];
globalThis.window.ethereum = {
  async request({ method, params }) {
    if (method === "eth_call") {
      const data = params[0].data;
      if (data.startsWith("0xff7485bc")) return encodeTermsAt("https://example.invalid/terms", 1756900000, false, true);
      throw new Error(`unexpected eth_call selector ${data.slice(0, 10)}`);
    }
    if (method === "eth_requestAccounts") return ["0x" + "aa".repeat(20)];
    if (method === "wallet_switchEthereumChain") return null;
    if (method === "eth_sendTransaction") {
      sentTx.push(params[0]);
      return "0x" + "bb".repeat(32);
    }
    throw new Error(`unexpected method ${method}`);
  },
};

const apiCorpus = {
  corpus_id: "corpus_1",
  manifest: { v: 1, kind: "corpus_manifest", org_id: "org_1", title: "demo", episodes: ["0x" + "01".repeat(32)] },
  corpus_manifest_hash: "0x" + "cc".repeat(32),
  corpus_root: "0x" + "ab".repeat(32),
  contains_revoked: true,
  on_chain_id: "0",
  on_chain: {
    termsHash: "0x" + "dd".repeat(32), episodeCount: 1, supplier: "0x" + "11".repeat(20),
    price: "1000000", token: "0x" + "22".repeat(20), open: true, sealedAt: 1756900000,
  },
};
globalThis.fetch = async (url) => {
  if (String(url).includes("/v1/corpora/corpus_1")) {
    return { ok: true, json: async () => apiCorpus };
  }
  throw new Error(`unexpected fetch ${url}`);
};

const record = await loadCorpus("corpus_1");
ok(record.offChainId === "corpus_1", "loadCorpus reads the off-chain corpus id from the log service");
ok(record.containsRevoked === true, "loadCorpus carries contains_revoked from the log service");
ok(record.onChain && record.onChain.id === "0", "loadCorpus carries the embedded on_chain record, no /onchain fallback needed");

const detailHost = document.createElement("div");
await loadDetail(detailHost, "corpus_1");
ok(detailHost.querySelectorAll(".record").length === 1, "detail view renders one record card");
ok(detailHost.querySelector('.notice[data-kind="warn"]'), "the contains_revoked warning uses design.css .notice[data-kind=warn]");
ok(/Contains a revoked episode/.test(detailHost.textContent), "detail view shows the contains_revoked warning");
ok(/Sources — not recorded for this corpus\./.test(detailHost.textContent), "a manifest with no sources[] renders the not-recorded fallback line");
ok(detailHost.innerHTML.includes(apiCorpus.corpus_manifest_hash), "detail view shows the corpus manifest hash (in the copy button's title/data-copy)");

// The purchase calldata is hidden until the "terms read" checkbox is ticked.
await new Promise((r) => setTimeout(r, 0)); // let the async terms/checkbox wiring settle
const checkbox = detailHost.querySelector("#terms-read");
ok(!!checkbox, "detail view renders the terms-read checkbox once terms are fetched");
const calldataHost = detailHost.querySelector(".calldata-host");
ok(calldataHost && calldataHost.hidden === true, "calldata is hidden before the checkbox is ticked");

checkbox.checked = true;
checkbox.dispatchEvent(new dom.window.Event("change"));
ok(calldataHost.hidden === false, "ticking the checkbox reveals the calldata");
const blocks = detailHost.querySelectorAll(".calldata");
ok(blocks.length === 2, "two calldata blocks: approve and license");
ok(blocks[0].textContent.startsWith("0x095ea7b3"), "the approve calldata starts with approve(address,uint256)'s selector");
ok(blocks[1].textContent.startsWith("0x178ed284"), "the license calldata starts with license(uint256)'s selector");
ok(detailHost.querySelectorAll('input[type="password"]').length === 0, "the page has no field asking for a private key anywhere");

// Wallet flow: clicking "send" goes through window.ethereum, never a key.
detailHost.querySelector("#send-approve").click();
await new Promise((r) => setTimeout(r, 0));
ok(sentTx.length === 1, "clicking send-approve calls eth_sendTransaction via the injected wallet");
ok(sentTx[0].data === blocks[0].textContent, "the sent tx carries exactly the shown approve calldata");

console.log(fails === 0 ? "\ncorpus states: all checks passed\n" : `\n${fails} check(s) failed\n`);
process.exit(fails ? 1 : 0);
