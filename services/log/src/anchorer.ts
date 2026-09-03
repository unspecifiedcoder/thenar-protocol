import { createPublicClient, createWalletClient, http, parseAbi, type Account, type Hex } from "viem";
import { LogStore } from "./store.ts";
import { type ChainTarget, loadChains, parseEnvFile } from "./chains.ts";
import { SparseTree, ZERO } from "../../../packages/protocol/src/sparse.ts";

/**
 * Anchors the log's real head on chain — on the primary and every mirror
 * (D-9), with the relayer key kept separate from stewardship (D-10).
 *
 * The size and root written are always `store.size()` / `store.root()`, so
 * an anchor cannot claim a size its root does not describe. That incoherence
 * is what made earlier anchors unverifiable.
 */

export const LOG_ABI = parseAbi([
  "function anchor(bytes32 root, uint64 size, bytes32 revocationRoot) returns (uint256)",
  "function anchorCount() view returns (uint256)",
  "function anchorAt(uint256) view returns ((bytes32 root, bytes32 prevRoot, bytes32 revocationRoot, uint64 size, uint64 at, uint64 blockNumber))",
]);

/**
 * The relayer key anchors; it never deploys or transfers stewardship. It
 * comes from `ANCHOR_RELAYER_KEY`; falling back to the deployer key is only
 * for a bootstrap environment that has not provisioned a relayer yet, and is
 * loud about it — anchoring with the deployer key defeats D-10 (a Safe can
 * revoke a relayer without also holding the deploy key).
 */
export function relayerKey(): Hex {
  if (process.env.ANCHOR_RELAYER_KEY) return process.env.ANCHOR_RELAYER_KEY as Hex;
  console.warn(
    "ANCHOR_RELAYER_KEY is not set — falling back to .env.deployer's DEPLOYER_PRIVATE_KEY. " +
    "This is only acceptable before a relayer key has been provisioned; anchoring with the " +
    "deployer key defeats the point of a Safe-controlled relayer (D-10).",
  );
  const env = parseEnvFile(".env.deployer");
  if (!env.DEPLOYER_PRIVATE_KEY) {
    throw new Error("neither ANCHOR_RELAYER_KEY nor .env.deployer's DEPLOYER_PRIVATE_KEY is set");
  }
  return env.DEPLOYER_PRIVATE_KEY as Hex;
}

export function revocationRoot(store: LogStore): Hex {
  const rs = store.revocations();
  if (rs.length === 0) return ZERO;
  const t = new SparseTree();
  for (const r of rs) t.set(r.consentKey, r.value);
  return t.root();
}

// --------------------------------------------------------------- chain I/O

/**
 * The minimal viem surface the anchorer needs. Production code gets a real
 * `PublicClient`/`WalletClient` pair (both satisfy these shapes); tests hand
 * in an in-memory model of `GraspLog` implementing the D-17 rule instead of
 * requiring Anvil.
 */
export type Reader = {
  readContract(args: { address: Hex; abi: unknown; functionName: string; args?: readonly unknown[] }): Promise<unknown>;
};
export type Writer = {
  writeContract(args: {
    address: Hex; abi: unknown; functionName: string; args?: readonly unknown[]; gas?: bigint;
  }): Promise<Hex>;
  waitForTransactionReceipt(args: { hash: Hex }): Promise<{ status: string; blockNumber: bigint }>;
};
export type Clients = { pub: Reader; wallet: Writer };

function chainDef(target: ChainTarget) {
  return {
    id: target.id,
    name: target.name,
    nativeCurrency: { name: target.name, symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [target.rpc] } },
  } as const;
}

function defaultReader(target: ChainTarget): Reader {
  return createPublicClient({ chain: chainDef(target), transport: http() });
}

function defaultClients(target: ChainTarget, signer: Account): Clients {
  const chain = chainDef(target);
  return {
    pub: createPublicClient({ chain, transport: http() }),
    wallet: createWalletClient({ account: signer, chain, transport: http() }),
  };
}

function isNothingToAnchor(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.includes("NothingToAnchor");
}

// ----------------------------------------------------------------- anchor

export type AnchorResult = {
  index: number; root: Hex; size: number; revocationRoot: Hex;
  txHash: Hex; blockNumber: number;
};

/**
 * Anchor the current head on `target`. Returns `null` when there is nothing
 * new to anchor for that chain — either because the chain head already
 * carries this exact `(size, revocationRoot)` (D-17's `NothingToAnchor`
 * case), or because the contract rejected the send with `NothingToAnchor`
 * itself (another writer got there first between our read and our send).
 *
 * The chain is always asked for its own head, never trusted from the store's
 * record alone — the store can be behind (restored from an older copy, or
 * pointed at a log something else has been anchoring), and trusting a local
 * number means submitting a size the contract will refuse.
 */
export async function anchorHead(
  store: LogStore,
  target: ChainTarget,
  signer: Account,
  clients: Clients = defaultClients(target, signer),
): Promise<AnchorResult | null> {
  const size = store.size();
  if (size === 0) return null;

  const { pub, wallet } = clients;

  const count = Number(await pub.readContract({
    address: target.log, abi: LOG_ABI, functionName: "anchorCount",
  }));

  let onChainSize = 0;
  let onChainRevRoot: Hex = ZERO;
  if (count > 0) {
    const head = await pub.readContract({
      address: target.log, abi: LOG_ABI, functionName: "anchorAt", args: [BigInt(count - 1)],
    }) as { size: bigint; revocationRoot: Hex };
    onChainSize = Number(head.size);
    onChainRevRoot = head.revocationRoot;
    if (size < onChainSize) {
      throw new Error(
        `the log is behind chain ${target.id} (${target.name}): this store holds ${size} leaves but ` +
        `${target.log} has already anchored ${onChainSize}. Restore the full log before anchoring again.`,
      );
    }
  }

  const root = store.root();
  const revRoot = revocationRoot(store);

  // D-17: equal size and equal revocation root is nothing new — sending
  // would only earn a NothingToAnchor revert. Checking first saves the
  // transaction; a same-size, changed-revocation-root anchor still goes
  // through, and that is exactly how a revocation-only anchor is sent.
  if (count > 0 && size === onChainSize && revRoot === onChainRevRoot) return null;

  let txHash: Hex;
  try {
    txHash = await wallet.writeContract({
      address: target.log, abi: LOG_ABI, functionName: "anchor",
      args: [root, BigInt(size), revRoot], gas: 200000n,
    });
  } catch (e) {
    if (isNothingToAnchor(e)) return null;
    throw e;
  }
  const receipt = await pub.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== "success") throw new Error(`anchor reverted on chain ${target.id} — ${txHash}`);

  const index = Number(await pub.readContract({
    address: target.log, abi: LOG_ABI, functionName: "anchorCount",
  })) - 1;
  const blockNumber = Number(receipt.blockNumber);

  store.recordAnchorChain(target.id, index, root, size, revRoot, txHash, blockNumber);
  // The legacy single-chain `anchor` table stays keyed to the primary chain
  // only, so `pnpm log status` / `lastAnchoredSize()` keep meaning what they
  // meant before mirrors existed.
  if (target.role === "primary") {
    store.recordAnchor(store.anchors().length, root, size, revRoot, txHash, blockNumber);
  }

  return { index, root, size, revocationRoot: revRoot, txHash, blockNumber };
}

// -------------------------------------------------------------- anchor all

export type AnchorOutcome =
  | { chainId: number; anchored: true; result: AnchorResult }
  | { chainId: number; anchored: false; error?: string };

/**
 * Anchor the primary, then every mirror, to the same `(root, size,
 * revocationRoot)` triple. The primary must succeed — without it there is
 * nothing coherent to mirror, so a primary failure aborts and throws. A
 * mirror failure (a reverted tx, an RPC timeout) is recorded in its outcome
 * and does not touch the primary's result or stop the remaining mirrors: a
 * down mirror is retried on the next run, not treated as this run's failure.
 */
export async function anchorAll(
  store: LogStore,
  signer: Account,
  chains: ChainTarget[] = loadChains(),
  clientsFor: (t: ChainTarget) => Clients = (t) => defaultClients(t, signer),
): Promise<AnchorOutcome[]> {
  const primary = chains.find((c) => c.role === "primary");
  if (!primary) throw new Error("no primary chain configured in .env.contracts");
  const mirrors = chains.filter((c) => c.role === "mirror");

  const outcomes: AnchorOutcome[] = [];

  const primaryResult = await anchorHead(store, primary, signer, clientsFor(primary));
  outcomes.push(
    primaryResult
      ? { chainId: primary.id, anchored: true, result: primaryResult }
      : { chainId: primary.id, anchored: false },
  );

  for (const mirror of mirrors) {
    try {
      const result = await anchorHead(store, mirror, signer, clientsFor(mirror));
      outcomes.push(
        result
          ? { chainId: mirror.id, anchored: true, result }
          : { chainId: mirror.id, anchored: false },
      );
    } catch (e) {
      outcomes.push({ chainId: mirror.id, anchored: false, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return outcomes;
}

// -------------------------------------------------------------- divergence

export type Divergence = { chainId: number; index: number; detail: string };

/**
 * Compare anchors across chains at equal sizes. Mirrors may lag behind the
 * primary (they anchor less often — only the latest head, D-9), so this
 * compares roots only where two chains happen to have anchored the same
 * size, never by anchor index (a mirror's index N is not the same anchor as
 * the primary's index N once it has caught up by skipping intermediate
 * heads).
 */
export async function checkDivergence(
  store: LogStore,
  targets: ChainTarget[],
  readerFor: (t: ChainTarget) => Reader = defaultReader,
): Promise<Divergence[]> {
  const primary = targets.find((t) => t.role === "primary") ?? targets[0];

  type Row = { chainId: number; index: number; root: Hex };
  const bySize = new Map<number, Row[]>();

  for (const target of targets) {
    const pub = readerFor(target);
    const count = Number(await pub.readContract({
      address: target.log, abi: LOG_ABI, functionName: "anchorCount",
    }));
    for (let i = 0; i < count; i++) {
      const a = await pub.readContract({
        address: target.log, abi: LOG_ABI, functionName: "anchorAt", args: [BigInt(i)],
      }) as { root: Hex; size: bigint };
      const size = Number(a.size);
      const list = bySize.get(size) ?? [];
      list.push({ chainId: target.id, index: i, root: a.root });
      bySize.set(size, list);
    }
  }

  const out: Divergence[] = [];
  for (const [size, rows] of bySize) {
    const reference = rows.find((r) => r.chainId === primary.id) ?? rows[0];
    for (const row of rows) {
      if (row.root !== reference.root) {
        out.push({
          chainId: row.chainId,
          index: row.index,
          detail: `at size ${size}, chain ${row.chainId} anchored ${row.root.slice(0, 14)}… but chain ` +
            `${reference.chainId} anchored ${reference.root.slice(0, 14)}…`,
        });
      }
    }
  }
  return out;
}

// -------------------------------------------------------------- audit

/**
 * Check every anchor `target`'s chain holds, not just the ones this store
 * happens to remember. Auditing only our own records is how an anchor
 * nobody can verify stays invisible: the store is restored from a copy, an
 * older anchor's leaves are gone, and a silent skip reports a clean log
 * over a hole in it.
 *
 * An anchor is coherent when the root the chain carries is the root of
 * exactly the first `size` leaves this store still holds.
 */
export type AnchorAudit = {
  index: number;
  status: "coherent" | "unverifiable" | "mismatch";
  detail: string;
};

export async function auditAnchors(
  store: LogStore,
  target: ChainTarget,
  reader: Reader = defaultReader(target),
): Promise<AnchorAudit[]> {
  const count = Number(await reader.readContract({
    address: target.log, abi: LOG_ABI, functionName: "anchorCount",
  }));

  const out: AnchorAudit[] = [];
  for (let i = 0; i < count; i++) {
    const onChain = await reader.readContract({
      address: target.log, abi: LOG_ABI, functionName: "anchorAt", args: [BigInt(i)],
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
