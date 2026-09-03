/**
 * Direct chain reads with a short cache — no indexer (D-29, PLAN §15).
 *
 * `GraspLog` is deployed byte-identical on a primary chain and its mirrors
 * (D-9); `LicenceRegistry` on the primary only. This module is the one place
 * `services/api` talks to either contract: a 15 s in-memory cache keyed by
 * `(chainId, call, args)` so a burst of requests for the same anchor/corpus
 * doesn't refetch on every hit, `stale_at` on every value so a caller can
 * tell a cache hit from a fresh read, and — on total RPC failure — an
 * `{ unreachable: true, chain_id }` shape instead of ever presenting a stale
 * value as live (I-11: never fabricate).
 *
 * `GraspLog` reads try the primary first and fall back to the first mirror
 * that answers; `LicenceRegistry` reads the primary only (it is not deployed
 * anywhere else).
 */
import { createPublicClient, http, parseAbi, type Hex, type PublicClient } from "viem";
import { loadChains, parseEnvFile, type ChainTarget } from "../../log/src/chains.ts";

export type { ChainTarget };

/** `ChainTarget` plus the primary's `LicenceRegistry` address, when deployed (D-9: primary-chain only). */
export type ChainReaderTarget = ChainTarget & { registry: Hex | null };

/**
 * Reads every `CHAIN_<id>_*` block from `path` (default `.env.contracts`,
 * same file `services/log/src/chains.ts` and the deploy scripts use) and
 * adds each chain's `REGISTRY` address, which the anchorer has no reason to
 * read but this module does.
 */
export function loadChainReaderTargets(path = ".env.contracts"): ChainReaderTarget[] {
  const chains = loadChains(path);
  const env = parseEnvFile(path);
  return chains.map((c) => ({ ...c, registry: (env[`CHAIN_${c.id}_REGISTRY`] as Hex | undefined) || null }));
}

const CACHE_TTL_MS = 15_000;

/** One cache entry per `(chainId, call, args)` key; dropped once older than `CACHE_TTL_MS`. */
class ReadCache {
  private entries = new Map<string, { value: unknown; fetchedAt: number }>();
  constructor(private now: () => number = Date.now) {}

  get<T>(key: string): { value: T; staleAt: number } | null {
    const e = this.entries.get(key);
    if (!e) return null;
    const staleAt = e.fetchedAt + CACHE_TTL_MS;
    if (this.now() >= staleAt) {
      this.entries.delete(key);
      return null;
    }
    return { value: e.value as T, staleAt };
  }

  set<T>(key: string, value: T): number {
    const fetchedAt = this.now();
    this.entries.set(key, { value, fetchedAt });
    return fetchedAt + CACHE_TTL_MS;
  }
}

function cacheKey(chainId: number, call: string, args: readonly unknown[]): string {
  return `${chainId}:${call}:${JSON.stringify(args, (_k, v) => (typeof v === "bigint" ? `bigint:${v}` : v))}`;
}

// --------------------------------------------------------------- contracts

const LOG_ABI = parseAbi([
  "function anchorCount() view returns (uint256)",
  "function anchorAt(uint256) view returns ((bytes32 root, bytes32 prevRoot, bytes32 revocationRoot, uint64 size, uint64 at, uint64 blockNumber))",
  "function indexOfRoot(bytes32) view returns (bool, uint256)",
  "function head() view returns ((bytes32 root, bytes32 prevRoot, bytes32 revocationRoot, uint64 size, uint64 at, uint64 blockNumber))",
]);

const REGISTRY_ABI = parseAbi([
  "function corpusAt(uint256) view returns ((bytes32 corpusManifestHash, bytes32 corpusRoot, bytes32 termsHash, uint64 episodeCount, address supplier, uint128 price, address token, bool open, uint64 sealedAt, bytes32 anchorRoot, uint64 anchorSize))",
  "function receiptAt(uint256) view returns ((address buyer, uint256 corpusId, bytes32 termsHash, bytes32 corpusRoot, bytes32 corpusManifestHash, uint256 amount, address token, uint64 at, uint64 blockNumber))",
  "function receiptsOf(address) view returns (uint256[])",
  "function termsAt(bytes32) view returns ((string uri, uint64 publishedAt, bool retired, bool exists))",
]);

export type GraspAnchor = { root: Hex; prevRoot: Hex; revocationRoot: Hex; size: number; at: number; blockNumber: number };
export type RegistryCorpus = {
  corpusManifestHash: Hex; corpusRoot: Hex; termsHash: Hex; episodeCount: number; supplier: Hex;
  price: string; token: Hex; open: boolean; sealedAt: number; anchorRoot: Hex; anchorSize: number;
};
export type RegistryReceipt = {
  buyer: Hex; corpusId: string; termsHash: Hex; corpusRoot: Hex; corpusManifestHash: Hex;
  amount: string; token: Hex; at: number; blockNumber: number;
};
export type RegistryTerms = { uri: string; publishedAt: number; retired: boolean; exists: boolean };

/** Every successful read carries `stale_at` (PLAN §15) — the moment this value stops being safe to call live. */
export type Live<T> = T & { stale_at: number; chain_id: number };
/** Total RPC failure (primary and, for `GraspLog` reads, every mirror) — never a substitute value (I-11). */
export type Unreachable = { unreachable: true; chain_id: number };
export type ChainResult<T> = Live<T> | Unreachable;

export function isUnreachable<T>(r: ChainResult<T>): r is Unreachable {
  return (r as Unreachable).unreachable === true;
}

function decodeAnchor(raw: { root: Hex; prevRoot: Hex; revocationRoot: Hex; size: bigint; at: bigint; blockNumber: bigint }): GraspAnchor {
  return {
    root: raw.root, prevRoot: raw.prevRoot, revocationRoot: raw.revocationRoot,
    size: Number(raw.size), at: Number(raw.at), blockNumber: Number(raw.blockNumber),
  };
}

function decodeCorpus(raw: {
  corpusManifestHash: Hex; corpusRoot: Hex; termsHash: Hex; episodeCount: bigint; supplier: Hex;
  price: bigint; token: Hex; open: boolean; sealedAt: bigint; anchorRoot: Hex; anchorSize: bigint;
}): RegistryCorpus {
  return {
    corpusManifestHash: raw.corpusManifestHash, corpusRoot: raw.corpusRoot, termsHash: raw.termsHash,
    episodeCount: Number(raw.episodeCount), supplier: raw.supplier, price: raw.price.toString(),
    token: raw.token, open: raw.open, sealedAt: Number(raw.sealedAt),
    anchorRoot: raw.anchorRoot, anchorSize: Number(raw.anchorSize),
  };
}

function decodeReceipt(raw: {
  buyer: Hex; corpusId: bigint; termsHash: Hex; corpusRoot: Hex; corpusManifestHash: Hex;
  amount: bigint; token: Hex; at: bigint; blockNumber: bigint;
}): RegistryReceipt {
  return {
    buyer: raw.buyer, corpusId: raw.corpusId.toString(), termsHash: raw.termsHash, corpusRoot: raw.corpusRoot,
    corpusManifestHash: raw.corpusManifestHash, amount: raw.amount.toString(), token: raw.token,
    at: Number(raw.at), blockNumber: Number(raw.blockNumber),
  };
}

function decodeTerms(raw: { uri: string; publishedAt: bigint; retired: boolean; exists: boolean }): RegistryTerms {
  return { uri: raw.uri, publishedAt: Number(raw.publishedAt), retired: raw.retired, exists: raw.exists };
}

function chainDef(target: ChainTarget) {
  return {
    id: target.id,
    name: target.name,
    nativeCurrency: { name: target.name, symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [target.rpc] } },
  } as const;
}

type ReadOutcome<T> = { ok: true; value: T; staleAt: number } | { ok: false };

/**
 * `services/api`'s injection point for on-chain reads (PLAN §15/§12): viem
 * public clients per chain from `.env.contracts`, typed `GraspLog`/
 * `LicenceRegistry` reads, and the 15 s cache described above.
 */
export class ViemChainReader {
  private clients = new Map<number, PublicClient>();
  private cache: ReadCache;
  private primary: ChainReaderTarget | null;
  /** primary first, then mirrors — the order every `GraspLog` fallback read tries chains in. */
  private graspOrder: ChainReaderTarget[];

  constructor(private chains: ChainReaderTarget[], now: () => number = Date.now) {
    this.cache = new ReadCache(now);
    const primaries = chains.filter((c) => c.role === "primary");
    if (chains.length > 0 && primaries.length !== 1) {
      throw new Error(`ViemChainReader requires exactly one primary chain; found ${primaries.length}`);
    }
    this.primary = primaries[0] ?? null;
    this.graspOrder = [...primaries, ...chains.filter((c) => c.role === "mirror").sort((a, b) => a.id - b.id)];
    for (const c of chains) {
      this.clients.set(c.id, createPublicClient({ chain: chainDef(c), transport: http() }) as PublicClient);
    }
  }

  private targetById(chainId: number): ChainReaderTarget | undefined {
    return this.chains.find((c) => c.id === chainId);
  }

  private async cachedRead<T>(chainId: number, call: string, args: readonly unknown[], fetch: () => Promise<T>): Promise<ReadOutcome<T>> {
    const key = cacheKey(chainId, call, args);
    const hit = this.cache.get<T>(key);
    if (hit) return { ok: true, value: hit.value, staleAt: hit.staleAt };
    try {
      const value = await fetch();
      const staleAt = this.cache.set(key, value);
      return { ok: true, value, staleAt };
    } catch {
      return { ok: false };
    }
  }

  private client(chainId: number): PublicClient {
    const c = this.clients.get(chainId);
    if (!c) throw new Error(`no RPC client configured for chain ${chainId}`);
    return c;
  }

  // ------------------------------------------------------------- GraspLog

  private graspLogAnchorCount(chainId: number): Promise<ReadOutcome<{ count: number }>> {
    return this.cachedRead(chainId, "anchorCount", [], async () => {
      const n = (await this.client(chainId).readContract({
        address: this.targetById(chainId)!.log, abi: LOG_ABI, functionName: "anchorCount",
      })) as bigint;
      return { count: Number(n) };
    });
  }

  private graspLogAnchorAt(chainId: number, index: number): Promise<ReadOutcome<GraspAnchor>> {
    return this.cachedRead(chainId, "anchorAt", [index], async () => {
      const raw = (await this.client(chainId).readContract({
        address: this.targetById(chainId)!.log, abi: LOG_ABI, functionName: "anchorAt", args: [BigInt(index)],
      })) as Parameters<typeof decodeAnchor>[0];
      return decodeAnchor(raw);
    });
  }

  private graspLogIndexOfRoot(chainId: number, root: Hex): Promise<ReadOutcome<{ found: boolean; index: number }>> {
    return this.cachedRead(chainId, "indexOfRoot", [root], async () => {
      const [found, index] = (await this.client(chainId).readContract({
        address: this.targetById(chainId)!.log, abi: LOG_ABI, functionName: "indexOfRoot", args: [root],
      })) as [boolean, bigint];
      return { found, index: Number(index) };
    });
  }

  private graspLogHead(chainId: number): Promise<ReadOutcome<GraspAnchor>> {
    return this.cachedRead(chainId, "head", [], async () => {
      const raw = (await this.client(chainId).readContract({
        address: this.targetById(chainId)!.log, abi: LOG_ABI, functionName: "head",
      })) as Parameters<typeof decodeAnchor>[0];
      return decodeAnchor(raw);
    });
  }

  /** Primary first, mirror fallback (D-9) — every chain carrying `GraspLog` answers the same log, so the first to respond wins. */
  private async withGraspFallback<T>(fn: (chainId: number) => Promise<ReadOutcome<T>>): Promise<ChainResult<T>> {
    for (const target of this.graspOrder) {
      const r = await fn(target.id);
      if (r.ok) return { ...r.value, stale_at: r.staleAt, chain_id: target.id } as Live<T>;
    }
    return { unreachable: true, chain_id: this.primary?.id ?? -1 };
  }

  anchorCount(): Promise<ChainResult<{ count: number }>> {
    return this.withGraspFallback((chainId) => this.graspLogAnchorCount(chainId));
  }

  anchorAt(index: number): Promise<ChainResult<GraspAnchor>> {
    return this.withGraspFallback((chainId) => this.graspLogAnchorAt(chainId, index));
  }

  indexOfRoot(root: Hex): Promise<ChainResult<{ found: boolean; index: number }>> {
    return this.withGraspFallback((chainId) => this.graspLogIndexOfRoot(chainId, root));
  }

  head(): Promise<ChainResult<GraspAnchor>> {
    return this.withGraspFallback((chainId) => this.graspLogHead(chainId));
  }

  /**
   * `anchorAt` on one specific chain, no fallback — for confirming a named
   * chain's own record (`GET /v1/anchors`'s per-chain `chains[]` live
   * confirmation) rather than the log in general.
   */
  async anchorAtOnChain(chainId: number, index: number): Promise<ChainResult<GraspAnchor>> {
    if (!this.targetById(chainId)) return { unreachable: true, chain_id: chainId };
    const r = await this.graspLogAnchorAt(chainId, index);
    if (!r.ok) return { unreachable: true, chain_id: chainId };
    return { ...r.value, stale_at: r.staleAt, chain_id: chainId };
  }

  // -------------------------------------------------------- LicenceRegistry

  /** LicenceRegistry reads are primary-chain only (D-9) — no fallback to try. */
  private async readRegistry<T>(call: string, args: readonly unknown[], decode: (raw: any) => T): Promise<ChainResult<T>> {
    const primary = this.primary;
    if (!primary || !primary.registry) return { unreachable: true, chain_id: primary?.id ?? -1 };
    const r = await this.cachedRead(primary.id, `registry:${call}`, args, async () => {
      const raw = await this.client(primary.id).readContract({
        address: primary.registry!, abi: REGISTRY_ABI, functionName: call as any, args: args as any,
      });
      return decode(raw);
    });
    if (!r.ok) return { unreachable: true, chain_id: primary.id };
    return { ...r.value, stale_at: r.staleAt, chain_id: primary.id } as Live<T>;
  }

  corpusAt(id: number | bigint): Promise<ChainResult<RegistryCorpus>> {
    return this.readRegistry("corpusAt", [BigInt(id)], decodeCorpus as (raw: any) => RegistryCorpus);
  }

  receiptAt(id: number | bigint): Promise<ChainResult<RegistryReceipt>> {
    return this.readRegistry("receiptAt", [BigInt(id)], decodeReceipt as (raw: any) => RegistryReceipt);
  }

  receiptsOf(buyer: Hex): Promise<ChainResult<{ ids: string[] }>> {
    return this.readRegistry("receiptsOf", [buyer], (raw: bigint[]) => ({ ids: raw.map((x) => x.toString()) }));
  }

  termsAt(termsHash: Hex): Promise<ChainResult<RegistryTerms>> {
    return this.readRegistry("termsAt", [termsHash], decodeTerms as (raw: any) => RegistryTerms);
  }
}
