#!/usr/bin/env node
// --experimental-strip-types
/**
 * `scripts/verify-report.mjs` — T-033, PLAN §10.10, the offline verifier a
 * third party runs against a Report v1 JSON (PLAN §9.6) plus the files a
 * `GET /v1/licences/{id}/download` delivered.
 *
 * Steps 2-7 are `apps/web/verify.js`'s own `verifyReport()` — that module
 * has no DOM dependency (browser globals are never touched) so it imports
 * unmodified under plain Node ESM; this CLI reuses it rather than a second
 * implementation, so the browser `/verify` page and this CLI can never
 * silently drift apart (`apps/web/merkle.js` underneath is what both the
 * page and this script fold proofs with).
 *
 * Step 1 (file hashes / payloadHash, §10.4) is this script's own addition
 * — the browser verifier never has the downloaded files, only this CLI
 * does. A mismatch here names both the offending file's path and the
 * episode leaf it belongs to (PLAN §21 step 8).
 *
 * An optional `--rpc`/`--chain` cross-check confirms the report's anchor
 * `(root, size)` is really `indexOfRoot`-known on that chain (needs
 * `--env-contracts` to resolve the chain's `GraspLog` address; skipped,
 * not failed, when omitted or unresolvable).
 *
 * Usage:
 *   npx tsx scripts/verify-report.mjs \
 *     --report <path> --files <dir> [--rpc <url> --chain <id> --env-contracts <path>]
 *
 * Exit 0 iff every step passes; exit 1 otherwise.
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { keccak256 } from "viem";

import { verifyReport as verifyReportSteps, findChain, readIndexOfRoot } from "../apps/web/verify.js";
import { payloadHash } from "../packages/protocol/src/payload.ts";
import { loadChains } from "../services/log/src/chains.ts";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    out[a.slice(2)] = argv[i + 1];
    i++;
  }
  return out;
}

/** Same filename convention `scripts/download.mjs` writes with. */
function localFileName(path) {
  return path.replace(/[\\/]/g, "_");
}

/** Step 1 (§10.4): every delivered file hashes to what the report's episode names, and payloadHash rebuilds to match. Returns a list of `{name, ok, detail}` rows, one per file plus one per episode's payloadHash. */
function checkFiles(report, filesDir) {
  const rows = [];
  for (const ep of report.episodes || []) {
    if (!ep.files || ep.files.length === 0) {
      rows.push({ name: `episode ${ep.log_index}: files`, ok: true, notChecked: true, detail: "report carries no files[] for this episode — nothing to check" });
      continue;
    }
    let allOk = true;
    for (const f of ep.files) {
      const local = join(filesDir, localFileName(f.path));
      if (!existsSync(local)) {
        allOk = false;
        rows.push({ name: `file ${f.path}`, ok: false, detail: `not found at ${local} (episode leaf ${ep.leaf})` });
        continue;
      }
      const bytes = readFileSync(local);
      const got = keccak256(bytes);
      const ok = got.toLowerCase() === f.hash.toLowerCase() && bytes.length === f.bytes;
      if (!ok) allOk = false;
      rows.push({
        name: `file ${f.path}`, ok,
        detail: ok
          ? `keccak256 matches (${f.bytes} bytes)`
          : `TAMPERED: file "${f.path}" (episode leaf ${ep.leaf}) hashes to ${got}, report names ${f.hash}` + (bytes.length !== f.bytes ? ` (also: ${bytes.length} bytes on disk, report names ${f.bytes})` : ""),
      });
    }
    try {
      const got = payloadHash(ep.files);
      const ok = got === ep.payload_hash;
      rows.push({
        name: `episode ${ep.log_index}: payloadHash`, ok,
        detail: ok ? "recomputed payloadHash matches" : `recomputed ${got}, report names ${ep.payload_hash} (episode leaf ${ep.leaf})`,
      });
      if (!ok) allOk = false;
    } catch (e) {
      allOk = false;
      rows.push({ name: `episode ${ep.log_index}: payloadHash`, ok: false, detail: e.message || String(e) });
    }
  }
  return rows;
}

async function checkChain(report, rpc, chainId, envContractsPath) {
  if (!rpc || !chainId) return null;
  let chains;
  try {
    chains = loadChains(envContractsPath ?? ".env.contracts");
  } catch {
    return { name: "chain cross-check (indexOfRoot)", ok: true, notChecked: true, detail: `could not load ${envContractsPath ?? ".env.contracts"} — skipped` };
  }
  const chain = chains.find((c) => String(c.id) === String(chainId));
  if (!chain) return { name: "chain cross-check (indexOfRoot)", ok: true, notChecked: true, detail: `chain ${chainId} not in .env.contracts — skipped` };
  const result = await readIndexOfRoot({ log: chain.log }, rpc, report.anchor.root);
  if (!result.reachable) {
    return { name: "chain cross-check (indexOfRoot)", ok: true, notChecked: true, detail: `chain ${chainId} unreachable at ${rpc}: ${result.error} — skipped, not failed (PLAN §22)` };
  }
  return {
    name: "chain cross-check (indexOfRoot)", ok: result.found,
    detail: result.found ? `chain ${chainId} confirms root at anchor index ${result.index}` : `chain ${chainId} does not know report anchor root ${report.anchor.root}`,
  };
}

function printTable(steps) {
  const width = Math.min(72, Math.max(...steps.map((s) => s.name.length), 20));
  for (const s of steps) {
    const mark = s.ok ? (s.notChecked ? "skip" : " ok ") : "FAIL";
    console.log(`[${mark}] ${s.name.padEnd(width)}  ${s.detail ?? ""}`);
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  if (!args.report || !args.files) {
    throw new Error("usage: verify-report.mjs --report <path> --files <dir> [--rpc <url> --chain <id> --env-contracts <path>]");
  }
  const report = JSON.parse(readFileSync(args.report, "utf8"));

  const fileSteps = checkFiles(report, args.files);
  const { steps: browserSteps, allPassed: browserPassed, reportHashOk } = verifyReportSteps(report);
  // drop verify.js's own step-1 placeholder ("not checked: the delivered
  // files are not available to this page") — this CLI's `fileSteps` is the
  // real thing.
  const otherSteps = browserSteps.filter((s) => s.name !== "step 1 — file hashes / payloadHash");

  const chainStep = await checkChain(report, args.rpc, args.chain, args["env-contracts"]);

  const allSteps = [...fileSteps, ...otherSteps, ...(chainStep ? [chainStep] : [])];
  printTable(allSteps);

  const allPassed = allSteps.every((s) => s.ok);
  console.log(`\nreport_hash: ${reportHashOk === null ? "not present in report" : reportHashOk ? "ok" : "MISMATCH"}`);
  console.log(allPassed ? "\nverify-report: PASS (all steps ok)" : "\nverify-report: FAIL");
  return { ok: allPassed, steps: allSteps };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((r) => process.exit(r.ok ? 0 : 1)).catch((e) => {
    console.error(e.stack ?? String(e));
    process.exit(1);
  });
}
