/**
 * `GET /v1/licences/{receiptId}/download` (PLAN §12) reads a `Receipt`
 * (PLAN §8: `buyer`, `corpusOnChainId`, …, chain-immutable) and the set of
 * files that make up its corpus's episodes. T-016 is the task that wires
 * this to a real viem client reading the primary chain with a mirror
 * fallback (D-9, D-29: "W1 reads chain state directly with a short cache;
 * no indexer"); this file only defines the narrow interface the download
 * route needs, plus a stub that says so, so `createApp(deps)` has a
 * clearly-typed injection point to swap in the real reader.
 */
import type { Hex } from "viem";
import { ApiError } from "./errors.ts";

export type ReceiptInfo = {
  buyer: `0x${string}`;
  corpusId: string;
};

/** One file that belongs to a corpus's episodes, addressed into the `BundleStore` by `hash`. */
export type CorpusFile = {
  path: string;
  hash: Hex;
  bytes: number;
};

export interface ChainReader {
  /** Reads a receipt by its on-chain id. `null` if it does not exist. */
  receiptAt(id: string): Promise<ReceiptInfo | null>;
  /** The file list across every episode in the corpus (D-4/D-18: the container files as delivered, no re-slicing). */
  corpusEpisodes(corpusId: string): Promise<CorpusFile[]>;
}

/** Default until T-016 lands: refuses rather than fabricating a receipt or file list (I-11). */
export class NotImplementedChainReader implements ChainReader {
  async receiptAt(_id: string): Promise<ReceiptInfo | null> {
    throw new ApiError("not_implemented", "chain reader not wired yet (T-016)");
  }
  async corpusEpisodes(_corpusId: string): Promise<CorpusFile[]> {
    throw new ApiError("not_implemented", "chain reader not wired yet (T-016)");
  }
}
