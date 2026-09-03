#!/usr/bin/env node
// --experimental-strip-types
/**
 * `scripts/download.mjs` — T-027, golden demo step 6 (PLAN §21).
 *
 * The buyer proves ownership of a receipt with a wallet signature (PLAN
 * §12 `GET /v1/licences/{id}/download`, `services/api/src/walletSig.ts`),
 * downloads every file the response names, and verifies each one's
 * `keccak(file) == hash` locally before trusting it — a corrupted or
 * substituted download is caught here, not assumed away.
 *
 * Usage:
 *   node --experimental-strip-types scripts/download.mjs \
 *     --receipt <id> --api <base-url> [--out <dir>]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";

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

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const receiptId = args.receipt;
  const apiBase = args.api;
  const outDir = args.out ?? `./download-${receiptId}`;
  if (!receiptId || !apiBase) throw new Error("usage: download.mjs --receipt <id> --api <base>");

  const buyerKey = env.BUYER_KEY;
  if (!buyerKey) throw new Error("BUYER_KEY is not set");
  const account = privateKeyToAccount(buyerKey);

  const unixMinute = Math.floor(Date.now() / 60_000);
  const message = `THENAR download receipt ${receiptId} at ${unixMinute}`;
  const signature = await account.signMessage({ message });
  const header = `${account.address}:${unixMinute}:${signature}`;

  const url = `${apiBase.replace(/\/$/, "")}/v1/licences/${encodeURIComponent(receiptId)}/download`;
  const res = await fetch(url, { headers: { "X-Wallet-Sig": header } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${url} -> ${res.status}: ${body}`);
  }
  const body = await res.json();

  mkdirSync(outDir, { recursive: true });
  const rows = [];
  for (const file of body.files) {
    // `LocalBundleStore.signedGetUrl` (T-015) returns a path relative to
    // this same API origin; `S3BundleStore`'s is already absolute.
    const fileUrl = /^https?:\/\//.test(file.url) ? file.url : `${apiBase.replace(/\/$/, "")}${file.url}`;
    const fileRes = await fetch(fileUrl);
    if (!fileRes.ok) throw new Error(`GET ${fileUrl} -> ${fileRes.status}`);
    const bytes = new Uint8Array(await fileRes.arrayBuffer());
    const computed = keccak256(bytes);
    const verified = computed.toLowerCase() === file.hash.toLowerCase() && bytes.length === file.bytes;
    const destPath = join(outDir, file.path.replace(/[\\/]/g, "_"));
    writeFileSync(destPath, bytes);
    rows.push({ path: file.path, hash: file.hash, bytes: file.bytes, verified });
  }

  console.log(`corpus: ${body.corpus_id}`);
  console.log("path".padEnd(40), "bytes".padEnd(10), "hash matches");
  for (const r of rows) {
    console.log(r.path.padEnd(40), String(r.bytes).padEnd(10), r.verified ? "ok" : "MISMATCH");
  }
  const failed = rows.filter((r) => !r.verified);
  if (failed.length > 0) {
    throw new Error(`${failed.length} file(s) failed keccak verification: ${failed.map((r) => r.path).join(", ")}`);
  }

  return { corpusId: body.corpus_id, files: rows };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.stack ?? String(e));
    process.exit(1);
  });
}
