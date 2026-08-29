/**
 * Operate the log.
 *
 *   pnpm log status
 *   pnpm log anchor
 *   pnpm log audit
 *   pnpm log proof <leafIndex>
 */
import { LogStore } from "./store.ts";
import { anchorHead, auditAnchors } from "./anchorer.ts";
import type { Hex } from "viem";

async function main() {
  const DB = process.env.THENAR_LOG_DB ?? ".data/log.db";
  const LOG_ADDRESS = (process.env.GRASP_LOG ?? "") as Hex;

  const store = new LogStore(DB);
  const cmd = process.argv[2] ?? "status";

  if (cmd === "status") {
    console.log(`db        ${DB}`);
    console.log(`leaves    ${store.size()}`);
    console.log(`root      ${store.size() ? store.root() : "(empty)"}`);
    console.log(`anchored  ${store.lastAnchoredSize()} leaves across ${store.anchors().length} anchor(s)`);
    for (const a of store.anchors()) console.log(`  #${a.idx}  size ${a.size}  block ${a.blockNumber}  ${a.root.slice(0, 18)}…`);
  } else if (cmd === "anchor") {
    if (!LOG_ADDRESS) throw new Error("set GRASP_LOG");
    const r = await anchorHead(store, LOG_ADDRESS);
    console.log(r ? `anchored #${r.index} size ${r.size} in block ${r.blockNumber}\n${r.txHash}` : "nothing new to anchor");
  } else if (cmd === "audit") {
    if (!LOG_ADDRESS) throw new Error("set GRASP_LOG");
    const rows = await auditAnchors(store, LOG_ADDRESS);
    for (const r of rows) console.log(`${r.coherent ? "  ok  " : " FAIL "} anchor #${r.index} — ${r.detail}`);
    process.exit(rows.every((r) => r.coherent) ? 0 : 1);
  } else if (cmd === "proof") {
    const i = Number(process.argv[3]);
    const leaf = store.leafAt(i);
    if (!leaf) throw new Error(`no leaf at ${i}`);
    console.log(JSON.stringify({ index: i, leaf: leaf.leaf, preimage: leaf.preimage,
      size: store.size(), root: store.root(), proof: store.inclusionProof(i) }, null, 2));
  } else {
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
  }
  store.close();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
