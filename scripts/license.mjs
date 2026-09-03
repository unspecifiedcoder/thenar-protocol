#!/usr/bin/env node
// --experimental-strip-types
/**
 * `scripts/license.mjs` — T-027, golden demo step 5 (PLAN §21).
 *
 * The buyer's half of a sale: read the sealed corpus straight off
 * `LicenceRegistry` (`corpusAt`, PLAN §11.3 — no API round trip needed,
 * every fact `license()` needs is on chain), check/set the ERC-20
 * allowance if short, call `license(corpusId)`, then read the receipt back
 * with `receiptAt` and print its fields (I-8: buyer, corpusId, termsHash,
 * corpusRoot, corpusManifestHash, amount, token).
 *
 * Usage:
 *   node --experimental-strip-types scripts/license.mjs \
 *     --corpus <onChainId> [--env-contracts <path>]
 */
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi, decodeEventLog } from "viem";
import { privateKeyToAccount } from "viem/accounts";
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

const REGISTRY_ABI = parseAbi([
  "function corpusAt(uint256) view returns ((bytes32 corpusManifestHash, bytes32 corpusRoot, bytes32 termsHash, uint64 episodeCount, address supplier, uint128 price, address token, bool open, uint64 sealedAt, bytes32 anchorRoot, uint64 anchorSize))",
  "function license(uint256 corpusId) returns (uint256)",
  "function receiptAt(uint256) view returns ((address buyer, uint256 corpusId, bytes32 termsHash, bytes32 corpusRoot, bytes32 corpusManifestHash, uint256 amount, address token, uint64 at, uint64 blockNumber))",
  "event Licensed(uint256 indexed receiptId, uint256 indexed corpusId, address indexed buyer, uint256 amount, uint256 toSupplier, uint256 toProtocol)",
]);

const ERC20_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function approve(address spender, uint256 amount) returns (bool)",
]);

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const onChainCorpusId = args.corpus;
  const envContractsPath = args["env-contracts"] ?? ".env.contracts";
  if (!onChainCorpusId) throw new Error("usage: license.mjs --corpus <onChainId>");

  const buyerKey = env.BUYER_KEY;
  if (!buyerKey) throw new Error("BUYER_KEY is not set");
  const account = privateKeyToAccount(buyerKey);

  const chains = loadChains(envContractsPath);
  const primary = chains.find((c) => c.role === "primary");
  if (!primary) throw new Error(`${envContractsPath} declares no primary chain`);
  const raw = readFileSync(envContractsPath, "utf8");
  const registryMatch = raw.match(new RegExp(`CHAIN_${primary.id}_REGISTRY=(0x[0-9a-fA-F]{40})`));
  if (!registryMatch) throw new Error(`${envContractsPath} has no CHAIN_${primary.id}_REGISTRY`);
  const registry = registryMatch[1];

  const pub = createPublicClient({ transport: http(primary.rpc) });
  const wallet = createWalletClient({ account, transport: http(primary.rpc) });

  const corpus = await pub.readContract({
    address: registry, abi: REGISTRY_ABI, functionName: "corpusAt", args: [BigInt(onChainCorpusId)],
  });
  if (!corpus.open) throw new Error(`corpus ${onChainCorpusId} is not open`);

  const allowance = await pub.readContract({
    address: corpus.token, abi: ERC20_ABI, functionName: "allowance", args: [account.address, registry],
  });
  if (allowance < corpus.price) {
    console.log(`approving ${corpus.price} of ${corpus.token} for ${registry}…`);
    const approveTx = await wallet.writeContract({
      chain: null, address: corpus.token, abi: ERC20_ABI, functionName: "approve",
      args: [registry, corpus.price],
    });
    const approveReceipt = await pub.waitForTransactionReceipt({ hash: approveTx });
    if (approveReceipt.status !== "success") throw new Error(`approve reverted — ${approveTx}`);
    console.log(`approve tx: ${approveTx}`);
  } else {
    console.log("allowance already sufficient — no approve sent");
  }

  const licenseTx = await wallet.writeContract({
    chain: null, address: registry, abi: REGISTRY_ABI, functionName: "license", args: [BigInt(onChainCorpusId)],
  });
  const licenseReceipt = await pub.waitForTransactionReceipt({ hash: licenseTx });
  if (licenseReceipt.status !== "success") throw new Error(`license reverted — ${licenseTx}`);

  let receiptId;
  for (const log of licenseReceipt.logs) {
    try {
      const decoded = decodeEventLog({ abi: REGISTRY_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName === "Licensed") { receiptId = decoded.args.receiptId.toString(); break; }
    } catch {
      // not a Licensed log from this ABI — skip.
    }
  }
  if (receiptId === undefined) throw new Error("license succeeded but emitted no Licensed event");

  const receipt = await pub.readContract({
    address: registry, abi: REGISTRY_ABI, functionName: "receiptAt", args: [BigInt(receiptId)],
  });

  console.log(`tx: ${licenseTx}`);
  console.log(`receipt id: ${receiptId}`);
  console.log("receipt fields:");
  console.log(`  buyer               ${receipt.buyer}`);
  console.log(`  corpusId            ${receipt.corpusId}`);
  console.log(`  termsHash           ${receipt.termsHash}`);
  console.log(`  corpusRoot          ${receipt.corpusRoot}`);
  console.log(`  corpusManifestHash  ${receipt.corpusManifestHash}`);
  console.log(`  amount              ${receipt.amount}`);
  console.log(`  token               ${receipt.token}`);

  return { txHash: licenseTx, receiptId, receipt };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e.stack ?? String(e));
    process.exit(1);
  });
}
