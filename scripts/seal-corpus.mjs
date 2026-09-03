#!/usr/bin/env node
// --experimental-strip-types
/**
 * `scripts/seal-corpus.mjs` — T-027, golden demo step 4 (PLAN §21).
 *
 * The supplier's half of a sale: fetch `GET /v1/corpora/{id}/seal-params`
 * (PLAN §12) from the log service, then call `LicenceRegistry.sealCorpus`
 * (PLAN §11.3) from `SUPPLIER_KEY` on the primary chain named in
 * `.env.contracts` (D-9) — never against a mirror, `LicenceRegistry` is
 * primary-only.
 *
 * Usage:
 *   node --experimental-strip-types scripts/seal-corpus.mjs \
 *     --corpus <id> --api <base-url> --price <uint> --token <address> \
 *     [--supplier-api-key <key>] [--env-contracts <path>]
 *
 * `--price`/`--token` are the caller's own commercial terms: the corpus
 * manifest (PLAN §9.2) does not carry a price or a settlement token, so
 * they are supplied here, echoed by `seal-params` into `seal_params`, and
 * proven against nothing but the caller's word (the log can only prove the
 * hashes it actually anchored — §11.3 checks those, not price/token).
 *
 * Prints the transaction hash and the on-chain corpus id, read out of the
 * `CorpusSealed` event rather than guessed from `corpusCount() - 1` (a
 * concurrent seal from another supplier would make that guess wrong).
 */
import { readFileSync } from "node:fs";
import {
  createPublicClient, createWalletClient, http, parseAbi, decodeEventLog,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadChains } from "../services/log/src/chains.ts";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const val = argv[i + 1];
    out[key] = val;
    i++;
  }
  return out;
}

/** A log service freshly brought up (golden demo, CI) can refuse the first connection or two while it finishes listening; a handful of short retries is cheaper than asking the operator to re-run the script. */
async function fetchWithRetry(url, init, attempts = 5, delayMs = 300) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fetch(url, init);
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastErr;
}

const REGISTRY_ABI = parseAbi([
  "function sealCorpus((bytes32 corpusManifestHash, bytes32 corpusRoot, bytes32 termsHash, uint64 episodeCount, address supplier, uint128 price, address token) p, bytes preimage03, bytes32[] logProof, uint64 leafIndex, uint256 anchorIndex) returns (uint256)",
  "event CorpusSealed(uint256 indexed corpusId, bytes32 indexed corpusManifestHash, bytes32 corpusRoot, address indexed supplier, uint128 price, address token)",
]);

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const corpusId = args.corpus;
  const apiBase = args.api;
  const price = args.price;
  const token = args.token;
  const envContractsPath = args["env-contracts"] ?? ".env.contracts";
  if (!corpusId || !apiBase || !price || !token) {
    throw new Error("usage: seal-corpus.mjs --corpus <id> --api <base> --price <uint> --token <address>");
  }

  const supplierKey = env.SUPPLIER_KEY;
  if (!supplierKey) throw new Error("SUPPLIER_KEY is not set");
  const account = privateKeyToAccount(supplierKey);

  const chains = loadChains(envContractsPath);
  const primary = chains.find((c) => c.role === "primary");
  if (!primary) throw new Error(`${envContractsPath} declares no primary chain`);
  const raw = readFileSync(envContractsPath, "utf8");
  const registryMatch = raw.match(new RegExp(`CHAIN_${primary.id}_REGISTRY=(0x[0-9a-fA-F]{40})`));
  if (!registryMatch) throw new Error(`${envContractsPath} has no CHAIN_${primary.id}_REGISTRY`);
  const registry = registryMatch[1];

  const headers = { accept: "application/json" };
  if (env.SUPPLIER_API_KEY) headers.authorization = `Bearer ${env.SUPPLIER_API_KEY}`;
  const url = `${apiBase.replace(/\/$/, "")}/v1/corpora/${encodeURIComponent(corpusId)}/seal-params`
    + `?price=${encodeURIComponent(price)}&token=${encodeURIComponent(token)}&supplier=${encodeURIComponent(account.address)}`;
  const res = await fetchWithRetry(url, { headers });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GET ${url} -> ${res.status}: ${body}`);
  }
  const body = await res.json();
  const { seal_params, preimage03, log_proof, leaf_index, anchor } = body;

  const anchorChain = anchor.chains.find((c) => c.chain_id === primary.id);
  if (!anchorChain) throw new Error(`the manifest leaf's anchor has not reached primary chain ${primary.id} yet`);

  const pub = createPublicClient({ transport: http(primary.rpc) });
  const wallet = createWalletClient({ account, transport: http(primary.rpc) });

  const txHash = await wallet.writeContract({
    chain: null,
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "sealCorpus",
    args: [
      {
        corpusManifestHash: seal_params.corpusManifestHash,
        corpusRoot: seal_params.corpusRoot,
        termsHash: seal_params.termsHash,
        episodeCount: BigInt(seal_params.episodeCount),
        supplier: seal_params.supplier,
        price: BigInt(seal_params.price),
        token: seal_params.token,
      },
      preimage03,
      log_proof,
      BigInt(leaf_index),
      BigInt(anchorChain.index),
    ],
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`sealCorpus reverted — ${txHash}`);

  let onChainId;
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: REGISTRY_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName === "CorpusSealed") {
        onChainId = decoded.args.corpusId.toString();
        break;
      }
    } catch {
      // not a CorpusSealed log from this ABI — skip.
    }
  }
  if (onChainId === undefined) throw new Error("sealCorpus succeeded but emitted no CorpusSealed event");

  console.log(`tx: ${txHash}`);
  console.log(`on-chain corpus id: ${onChainId}`);
  return { txHash, onChainId };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.stack ?? String(e));
    process.exit(1);
  });
}
