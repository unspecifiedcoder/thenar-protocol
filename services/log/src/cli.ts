/**
 * Operate the log.
 *
 *   pnpm log status
 *   pnpm log anchor [--chain <id>|all]
 *   pnpm log audit [--chain <id>|all]
 *   pnpm log proof <leafIndex>
 *
 * Chain targets come from `.env.contracts` (or `THENAR_ENV_CONTRACTS`); the
 * relayer key comes from `ANCHOR_RELAYER_KEY` (see `anchorer.ts`).
 */
import { LogStore } from "./store.ts";
import { anchorHead, anchorAll, auditAnchors, checkDivergence, relayerKey, type AnchorOutcome } from "./anchorer.ts";
import { loadChains } from "./chains.ts";
import { privateKeyToAccount } from "viem/accounts";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

function describeOutcome(o: AnchorOutcome): string {
  if (o.anchored) {
    return `chain ${o.chainId}: anchored #${o.result.index} size ${o.result.size} in block ${o.result.blockNumber}\n  ${o.result.txHash}`;
  }
  return o.error ? `chain ${o.chainId}: FAILED — ${o.error}` : `chain ${o.chainId}: nothing new to anchor`;
}

async function main() {
  const DB = process.env.THENAR_LOG_DB ?? ".data/log.db";
  const ENV_CONTRACTS = process.env.THENAR_ENV_CONTRACTS ?? ".env.contracts";

  const store = new LogStore(DB);
  const cmd = process.argv[2] ?? "status";

  if (cmd === "status") {
    console.log(`db        ${DB}`);
    console.log(`leaves    ${store.size()}`);
    console.log(`root      ${store.size() ? store.root() : "(empty)"}`);
    console.log(`anchored  ${store.lastAnchoredSize()} leaves across ${store.anchors().length} anchor(s)`);
    for (const a of store.anchors()) console.log(`  #${a.idx}  size ${a.size}  block ${a.blockNumber}  ${a.root.slice(0, 18)}…`);
  } else if (cmd === "anchor") {
    const chainArg = flag("chain") ?? "all";
    const signer = privateKeyToAccount(relayerKey());
    if (chainArg === "all") {
      const outcomes = await anchorAll(store, signer, loadChains(ENV_CONTRACTS));
      for (const o of outcomes) console.log(describeOutcome(o));
      process.exit(outcomes.some((o) => !o.anchored && o.error) ? 1 : 0);
    } else {
      const chains = loadChains(ENV_CONTRACTS);
      const target = chains.find((c) => String(c.id) === chainArg);
      if (!target) throw new Error(`unknown chain id ${chainArg}; known chains: ${chains.map((c) => c.id).join(", ")}`);
      const r = await anchorHead(store, target, signer);
      console.log(r ? `anchored #${r.index} size ${r.size} in block ${r.blockNumber}\n${r.txHash}` : "nothing new to anchor");
    }
  } else if (cmd === "audit") {
    const chainArg = flag("chain") ?? "all";
    const chains = loadChains(ENV_CONTRACTS);
    const targets = chainArg === "all" ? chains : chains.filter((c) => String(c.id) === chainArg);
    if (targets.length === 0) throw new Error(`unknown chain id ${chainArg}; known chains: ${chains.map((c) => c.id).join(", ")}`);

    const mark = { coherent: "  ok  ", unverifiable: " HOLE ", mismatch: " FAIL " } as const;
    let bad = 0;
    for (const target of targets) {
      console.log(`\nchain ${target.id} (${target.name}):`);
      const rows = await auditAnchors(store, target);
      for (const r of rows) console.log(`${mark[r.status]} anchor #${r.index} — ${r.detail}`);
      bad += rows.filter((r) => r.status === "mismatch").length;
    }
    if (targets.length > 1) {
      const divergences = await checkDivergence(store, targets);
      for (const d of divergences) console.log(`\n DIVERGE  chain ${d.chainId} anchor #${d.index} — ${d.detail}`);
      bad += divergences.length;
    }
    process.exit(bad > 0 ? 1 : 0);
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
