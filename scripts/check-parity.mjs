/**
 * The two chain repositories must carry the same protocol, contracts and web
 * app. Only the chain config, the deployment record and anything naming a live
 * deployment may differ.
 *
 * thenar-avax fell 27 files behind once — missing the exporter, the corpus page
 * and the scene renderer — and separately kept an old grasp.js whose loop never
 * restarted. Neither showed up until its suite was run by hand.
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";

const A = process.argv[2] ?? "..";
const B = process.argv[3] ?? "../thenar-avax";
let fails = 0;
const ok = (c, m, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };

/** Per-chain by design; drift here is expected, not a fault. */
const EXEMPT = new Set([
  "apps/web/grasp-chain.js",      // addresses and RPC
  "package.json",                 // deploy scripts and suite list
  "README.md",
  "foundry.toml",
  "packages/contracts/foundry.toml",
  "apps/web/sample-proof.json",
  "apps/web/sample-episode.json",
  "apps/web/sample-task.json",
  "packages/protocol/test/selectors.ts",
  "scripts/check-samples.mjs",
  "scripts/check-parity.mjs",
  ".env.contracts",
  "apps/web/.vercel/project.json",   // links a directory to its own Vercel project
  "services/log/src/chain.ts",      // the chain itself
]);

const SHARED = ["packages/protocol/src", "packages/contracts/src", "services", "apps/web"];

function walk(root, dir, out = []) {
  const full = join(root, dir);
  if (!existsSync(full)) return out;
  for (const e of readdirSync(full)) {
    const rel = join(dir, e);
    // An exported corpus belongs to the deployment that produced it.
    if (/node_modules|\.git|^out$|^cache$|^lib$|^broadcast$|^corpus-\d+$|\.glb$|\.png$/.test(e)) continue;
    const p = join(root, rel);
    if (statSync(p).isDirectory()) walk(root, rel, out);
    else out.push(rel);
  }
  return out;
}

const digest = (p) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 12);

let compared = 0, missing = [], differing = [];
for (const area of SHARED) {
  for (const rel of walk(A, area)) {
    if (EXEMPT.has(rel)) continue;
    compared++;
    const b = join(B, rel);
    if (!existsSync(b)) { missing.push(rel); continue; }
    if (digest(join(A, rel)) !== digest(b)) differing.push(rel);
  }
}

ok(compared > 0, "found shared files to compare", `${compared}`);
ok(missing.length === 0, "every shared file exists in both repositories",
   missing.length ? missing.join(", ") : "");
ok(differing.length === 0, "and is byte-identical",
   differing.length ? differing.join(", ") : "");

console.log(fails === 0 ? "\nrepositories are in parity\n" : `\n${fails} parity problem(s)\n`);
process.exit(fails ? 1 : 0);
