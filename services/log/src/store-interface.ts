import type { Hex } from "viem";
import type { ConsentRecord } from "../../../packages/protocol/src/consent.ts";
import type { StoredLeaf } from "./store.ts";

/**
 * The log store's public contract (PLAN.md Sec14, T-014). Kept separate from
 * `store.ts` so a caller can depend on the shape without pulling in
 * `node:sqlite` — and so a future non-SQLite implementation (Postgres,
 * D-24, deferred) has a fixed target.
 */
export interface ILogStore {
  append(leaf: Hex, meta?: Partial<Omit<StoredLeaf, "index" | "leaf" | "createdAt">>): number;
  size(): number;
  leaves(upTo?: number): Hex[];
  leafAt(index: number): StoredLeaf | null;
  indexOfLeaf(leaf: Hex): number | null;
  byTask(taskId: Hex): StoredLeaf[];

  root(upTo?: number): Hex;
  inclusionProof(index: number, size?: number): Hex[];
  consistencyProof(m: number, n?: number): Hex[];

  revoke(record: ConsentRecord, signature: Hex): Promise<{ consentKey: Hex; value: Hex }>;
  revocations(): { consentKey: Hex; value: Hex }[];

  recordAnchor(idx: number, root: Hex, size: number, revocationRoot: Hex, txHash: string, blockNumber: number): void;
  anchors(): { idx: number; root: Hex; size: number; revocationRoot: Hex; txHash: string; blockNumber: number }[];
  lastAnchoredSize(): number;
  anchorBy(root: Hex, size: number): { idx: number; root: Hex; size: number; revocationRoot: Hex; txHash: string; blockNumber: number } | null;

  recordAnchorChain(
    chainId: number, idx: number, root: Hex, size: number, revocationRoot: Hex, txHash: string, blockNumber: number,
  ): void;
  anchorsForChain(chainId?: number): {
    chainId: number; idx: number; root: Hex; size: number; revocationRoot: Hex | null; txHash: string; blockNumber: number;
  }[];
  anchorChains(root: Hex, size: number): {
    chainId: number; idx: number; root: Hex; size: number; revocationRoot: Hex | null; txHash: string; blockNumber: number;
  }[];
  lastAnchored(chainId: number): { size: number; revocationRoot: Hex } | null;

  episodeMeta(leafHash: Hex): EpisodeMeta | null;

  recordClaim(claim: ClaimRow): void;
  claimsFor(leafHash: Hex): ClaimRow[];

  byOrg(orgId: string, cursor?: number, limit?: number): { items: StoredLeaf[]; nextCursor: number | null };
  byDataset(datasetId: string): StoredLeaf[];

  close(): void;
}

export type EpisodeMeta = StoredLeaf & {
  manifest: string | null;
  manifestHash: Hex | null;
  payloadHash: Hex | null;
  datasetId: string | null;
  orgId: string | null;
  consentKey: Hex | null;
  submittedAt: number | null;
};

export type ClaimRow = {
  leafHash: Hex;
  subjectLeaf: Hex;
  verifierKeyId: Hex;
  check: string;
  result: "pass" | "fail" | "inconclusive";
  levelAsserted: number | null;
  detail: string;
  detailHash: Hex;
  issuedAt: number;
  signature: string | null;
};
