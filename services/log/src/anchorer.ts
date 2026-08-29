import { createPublicClient, createWalletClient, http, parseAbi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readFileSync } from "node:fs";
import { LogStore } from "./store.ts";
import { CHAIN } from "./chain.ts";
import { SparseTree, ZERO } from "../../../packages/protocol/src/sparse.ts";

/**
 * Anchors the log's real head on chain.
 *
 * The size written is always `store.size()` and the root is always the root of
 * exactly those leaves, so an anchor cannot claim a size its root does not
 * describe. That incoherence is what made earlier anchors unverifiable.
 */

export const LOG_ABI = parseAbi([
  "function anchor(bytes32 root, uint64 size, bytes32 revocationRoot) returns (uint256)",
  "function anchorCount() view returns (uint256)",
  "function anchorAt(uint256) view returns ((bytes32 root, bytes32 prevRoot, bytes32 revocationRoot, uint64 size, uint64 at, uint64 blockNumber))",
]);

export function deployerKey(): Hex {
  const env = Object.fromEntries(
    readFileSync(".env.deployer", "utf8").split("\n").filter(Boolean)
      .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }),
  );
  if (!env.DEPLOYER_PRIVATE_KEY) throw new Error("DEPLOYER_PRIVATE_KEY missing from .env.deployer");
  return env.DEPLOYER_PRIVATE_KEY as Hex;
}

export function revocationRoot(store: LogStore): Hex {
  const rs = store.revocations();
  if (rs.length === 0) return ZERO;
  const t = new SparseTree();
  for (const r of rs) t.set(r.consentKey, r.value);
  return t.root();
}

export type AnchorResult = {
  index: number; root: Hex; size: number; revocationRoot: Hex;
  txHash: Hex; blockNumber: number;
};

/** Anchor the current head. Returns null when there is nothing new to anchor. */
export async function anchorHead(store: LogStore, logAddress: Hex): Promise<AnchorResult | null> {
  const size = store.size();
  if (size === 0) return null;

  const account = privateKeyToAccount(deployerKey());
  const pub = createPublicClient({ chain: CHAIN, transport: http() });
  const wallet = createWalletClient({ account, chain: CHAIN, transport: http() });

  // Ask the chain, not our own record. The store can be behind — restored from
  // an older copy, or pointed at a log something else has been anchoring — and
  // trusting the local number means submitting a size the contract will refuse.
  const count = Number(await pub.readContract({
    address: logAddress, abi: LOG_ABI, functionName: "anchorCount",
  }));
  if (count > 0) {
    const head = await pub.readContract({
      address: logAddress, abi: LOG_ABI, functionName: "anchorAt", args: [BigInt(count - 1)],
    }) as { size: bigint };
    const onChainSize = Number(head.size);
    if (size < onChainSize) {
      throw new Error(
        `the log is behind the chain: this store holds ${size} leaves but ${logAddress} ` +
        `has already anchored ${onChainSize}. Restore the full log before anchoring again.`,
      );
    }
    if (size === onChainSize) return null; // the head has not moved
  }

  const root = store.root();
  const revRoot = revocationRoot(store);

  // Monad reserves value + gas_limit x price, so an oversized limit locks up
  // balance the transaction never spends.
  const txHash = await wallet.writeContract({
    address: logAddress, abi: LOG_ABI, functionName: "anchor",
    args: [root, BigInt(size), revRoot], gas: 200000n,
  });
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`anchor reverted — ${txHash}`);

  const index = Number(await pub.readContract({ address: logAddress, abi: LOG_ABI, functionName: "anchorCount" })) - 1;
  store.recordAnchor(index, root, size, revRoot, txHash, Number(receipt.blockNumber));
  return { index, root, size, revocationRoot: revRoot, txHash, blockNumber: Number(receipt.blockNumber) };
}

/**
 * Check every anchor the CHAIN holds, not just the ones this store happens to
 * remember. Auditing only our own records is how an anchor nobody can verify
 * stays invisible: the store is restored from a copy, an older anchor's leaves
 * are gone, and a silent skip reports a clean log over a hole in it.
 *
 * An anchor is coherent when the root the chain carries is the root of exactly
 * the first `size` leaves this store still holds. Anything else is reported,
 * with which of the two it is: a hole we cannot re-derive, or a genuine mismatch.
 */
export type AnchorAudit = {
  index: number;
  status: "coherent" | "unverifiable" | "mismatch";
  detail: string;
};

export async function auditAnchors(store: LogStore, logAddress: Hex): Promise<AnchorAudit[]> {
  const pub = createPublicClient({ chain: CHAIN, transport: http() });
  const count = Number(await pub.readContract({
    address: logAddress, abi: LOG_ABI, functionName: "anchorCount",
  }));

  const out: AnchorAudit[] = [];
  for (let i = 0; i < count; i++) {
    const onChain = await pub.readContract({
      address: logAddress, abi: LOG_ABI, functionName: "anchorAt", args: [BigInt(i)],
    }) as { root: Hex; size: bigint };
    const size = Number(onChain.size);

    if (size > store.size()) {
      out.push({
        index: i, status: "unverifiable",
        detail: `chain anchored ${size} leaves; this store holds ${store.size()}`,
      });
      continue;
    }
    const rebuilt = store.root(size);
    out.push(
      rebuilt === onChain.root
        ? { index: i, status: "coherent", detail: `size ${size}, root re-derives` }
        : {
            index: i, status: "mismatch",
            detail: `size ${size}: chain ${onChain.root.slice(0, 14)}…, store rebuilds ${rebuilt.slice(0, 14)}…`,
          },
    );
  }
  return out;
}
