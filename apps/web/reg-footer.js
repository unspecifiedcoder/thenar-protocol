/* reg-footer.js — fills the register nav's chain chip and builds the
 * register footer, from `chains.js`, so no page hard-codes a 0x-hex address
 * or chain name outside `chains.js` (T-041c; copy.test.mjs forbids a bare
 * 0x40-hex address anywhere but `chains.js`/README.md) and every rebuilt
 * page shares exactly one footer markup (coordinator review, T-041c).
 *
 * Runs on import — every rebuilt page includes this as a module script and
 * marks its placeholders with `[data-chain-chip]` / `[data-reg-footer]`; a
 * page with neither is a no-op.
 */
import { CHAINS } from "./chains.js";

/** One line of links, then the three contract rows. */
const FOOTER_LINKS = [
  ["Verify", "./verify.html"],
  ["Corpora", "./corpus.html"],
  ["Protocol", "./protocol.html"],
  ["Company", "./company.html"],
  ["Lab", "./lab/build.html"],
  ["Terms", "./terms.html"],
  ["Privacy", "./privacy.html"],
  ["Source", "https://github.com/nickthelegend/aibo-pet"],
];

function footerHtml(chain) {
  const links = FOOTER_LINKS.map(([label, href]) => `<a href="${href}">${label}</a>`).join(" · ");
  const rows = [
    ["GraspLog", chain.log],
    ["LeafVerifier", chain.verifier],
    ["LicenceRegistry", chain.registry],
  ].map(([label, addr]) => `<div><span class="small" style="color:var(--ink-2)">${label}</span> <span class="hash">${addr}</span></div>`).join("");
  return `<nav aria-label="More">${links}</nav><div class="addrs">${rows}</div>`;
}

export function mountRegChrome(root = document) {
  const chain = CHAINS.find((c) => c.role === "primary") || CHAINS[0];
  if (!chain) return;

  for (const chip of root.querySelectorAll("[data-chain-chip]")) {
    chip.textContent = chain.name;
    chip.dataset.state = "ok";
  }

  for (const host of root.querySelectorAll("[data-reg-footer]")) {
    host.innerHTML = footerHtml(chain);
  }
}

mountRegChrome();
