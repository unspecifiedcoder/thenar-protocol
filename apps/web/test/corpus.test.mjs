/**
 * The corpus page's states, without a chain.
 *
 * The empty and error states are the two a reviewer is most likely to hit and
 * the two hardest to reach in a browser, because the real market is never
 * empty and the RPC is rarely down on cue.
 */
import { JSDOM } from "jsdom";

let fails = 0;
const ok = (c, m, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };

const dom = new JSDOM(`<!doctype html><div id="corpora"></div>`, { url: "https://thenar.io/corpus" });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
// navigator is a getter-only global in modern Node, so define rather than assign.
Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
globalThis.getSelection = () => dom.window.getSelection();
globalThis.Element = dom.window.Element;
globalThis.fetch = async () => { throw new Error("no network in this test"); };

const { render, renderError } = await import("../corpus.js");
const host = document.querySelector("#corpora");

render(host, [], [], 0);
ok(/No corpus has been sealed yet/.test(host.textContent), "empty state says no corpus has been sealed");
ok(host.querySelector('.cempty[data-state="empty"]'), "and marks itself as the empty state");
ok(host.querySelectorAll(".card").length === 0, "and renders no cards");

renderError(host, "boom");
ok(host.querySelector('.cempty[data-state="error"]'), "error state is marked");
ok(/nothing is shown rather than guessed/.test(host.textContent), "and says nothing is guessed");
ok(!/Corpus #/.test(host.textContent), "and shows no corpus");

const corpus = {
  index: 0, taskId: 0n, corpusRoot: "0x" + "ab".repeat(32), corpusSize: 40,
  price: 20000000000000000n, token: "0x0000000000000000000000000000000000000000",
  open: true, contributorCount: 2,
  contributors: ["0x" + "11".repeat(20), "0x" + "22".repeat(20)],
  weights: [7000n, 3000n], weightTotal: 10000n,
};
const task = { index: 0, curator: "0x" + "33".repeat(20), curatorBps: 1000 };
render(host, [corpus], [task], 1);
ok(host.querySelectorAll(".card").length === 1, "a corpus renders one card");

const tables = host.querySelectorAll(".captable");
const split = [...tables[0].querySelectorAll("tbody tr")].map((tr) => parseFloat(tr.children[2].textContent));
ok(Math.abs(split.reduce((a, b) => a + b, 0) - 0.02) < 1e-9,
   "protocol + curator + contributors equal the licence price", split.join(" + "));
const shares = [...tables[1].querySelectorAll("tbody tr")].map((tr) => parseFloat(tr.children[3].textContent));
ok(Math.abs(shares.reduce((a, b) => a + b, 0) - split[2]) < 1e-9,
   "contributor rows equal the contributor pool", `${shares.join(" + ")} = ${split[2]}`);
ok(host.querySelectorAll(".bar > span").length === 2, "one bar segment per contributor");
ok(host.querySelectorAll(".hist i").length === 12, "the histogram has its bins");

console.log(fails === 0 ? "\ncorpus states: all checks passed\n" : `\n${fails} check(s) failed\n`);
process.exit(fails ? 1 : 0);
