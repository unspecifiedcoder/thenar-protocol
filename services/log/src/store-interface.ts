import type { Hex } from "viem";
import type { ConsentRecord } from "../../../packages/protocol/src/consent.ts";
import type { StoredLeaf } from "./store.ts";

/**
 * The log store's public contract (PLAN.md Sec14, T-014). Kept separate from
 * `store.ts` so a caller can depend on the shape without pulling in
 * `node:sqlite` — and so a future non-SQLite implementation (Postgres,
 * D-24, deferred) has a fixed target.
 */
/**
 * Episode metadata a caller may attach at `append` time (PLAN Sec8 Episode
 * row) on top of the base `StoredLeaf` fields — kept as its own type rather
 * than widening `StoredLeaf` itself, since `manifest`/`manifestHash`/
 * `payloadHash`/`datasetId`/`orgId`/`consentKey`/`submittedAt` are episode
 * (0x02 leaf) concepts, not something every leaf kind carries.
 */
export type LeafMeta = Partial<Omit<StoredLeaf, "index" | "leaf" | "createdAt">> & {
  manifest?: string;
  manifestHash?: Hex;
  payloadHash?: Hex;
  datasetId?: string;
  orgId?: string;
  consentKey?: Hex;
  submittedAt?: number;
};

export interface ILogStore {
  append(leaf: Hex, meta?: LeafMeta): number;
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
    chainId: number; idx: number; root: Hex; size: number; revocationRoot: Hex | null; txHash: string; blockNumber: number; at: number;
  }[];
  anchorChains(root: Hex, size: number): {
    chainId: number; idx: number; root: Hex; size: number; revocationRoot: Hex | null; txHash: string; blockNumber: number; at: number;
  }[];
  lastAnchored(chainId: number): { size: number; revocationRoot: Hex } | null;

  // ------------------------------------------------------------------ corpus (T-016 reads)

  corpusById(corpusId: string): CorpusRow | null;
  corpusEpisodeLeaves(corpusId: string): { leafHash: Hex; corpusIndex: number }[];

  episodeMeta(leafHash: Hex): EpisodeMeta | null;

  /** The episode (0x02 leaf) row logged for `orgId` with this exact `manifestHash`, or null (T-036 duplicate check). */
  episodeByManifestHash(orgId: string, manifestHash: Hex): EpisodeMeta | null;

  recordClaim(claim: ClaimRow): void;
  claimsFor(leafHash: Hex): ClaimRow[];

  byOrg(orgId: string, cursor?: number, limit?: number): { items: StoredLeaf[]; nextCursor: number | null };
  byDataset(datasetId: string): StoredLeaf[];

  // -------------------------------------------------- org / key registry (T-024)

  createOrg(org: OrgRow): void;
  org(orgId: string): OrgRow | null;

  insertApiKey(row: ApiKeyRow): void;
  apiKeyByHash(keyHash: string): ApiKeyRow | null;

  insertSigningKey(row: SigningKeyRow): void;
  signingKey(keyId: Hex): SigningKeyRow | null;
  revokeSigningKey(keyId: Hex, validTo: number): void;
  signingKeysForOrg(orgId: string): SigningKeyRow[];

  // ------------------------------------------------------- datasets/jobs (T-036)

  createDataset(row: DatasetRow): void;
  datasetById(datasetId: string): DatasetRow | null;

  createJob(row: JobRow): void;
  jobById(jobId: string): JobRow | null;
  updateJob(jobId: string, patch: { status?: string; payload?: string | null; error?: string | null }): void;

  /**
   * Atomically claims `saltHash = keccak(salt)` for `orgId`: returns `true`
   * and records the claim the first time a given hash is presented, `false`
   * on a repeat (PLAN Sec10.5, Sec27 trap #9 — the salt itself never passes
   * through here, only its hash).
   */
  claimSalt(saltHash: Hex, orgId: string): boolean;

  close(): void;
}

/** PLAN Sec8 Dataset row (`dataset` table). `filesJson` is the dataset's `files[]` (FileEntry[]) as JSON text. */
export type DatasetRow = {
  datasetId: string;
  orgId: string;
  sourceUri: string | null;
  infoJsonHash: Hex;
  filesJson: string;
  status: "uploading" | "committed";
  createdAt: number;
};

/** `job` table row (T-036 ingest job). `payload` is a JSON blob the job kind defines the shape of. */
export type JobRow = {
  jobId: string;
  kind: string;
  status: string;
  payload: string | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
};

export type EpisodeMeta = StoredLeaf & {
  manifest: string | null;
  manifestHash: Hex | null;
  payloadHash: Hex | null;
  datasetId: string | null;
  orgId: string | null;
  consentKey: Hex | null;
  submittedAt: number | null;
};

/** PLAN Sec8 Organisation. */
export type OrgRow = {
  orgId: string;
  name: string;
  kind: "supplier" | "buyer" | "verifier";
  status: "active" | "suspended";
  createdAt: number;
};

/** One `Authorization: Bearer` credential (PLAN Sec12 auth, T-024). Only the sha256 digest is ever stored. */
export type ApiKeyRow = {
  keyId: string;
  orgId: string;
  keyHash: string;
  role: string;
  createdAt: number;
  revokedAt: number | null;
};

/** PLAN Sec8 SigningKey / Sec10.6 `keyId = keccak(pubkeyBytes)`. */
export type SigningKeyRow = {
  keyId: Hex;
  orgId: string;
  alg: "ed25519" | "p256" | "secp256k1";
  pubkey: Hex;
  validFrom: number;
  validTo: number | null;
  attestation: string | null;
  status: "active" | "expired" | "revoked";
};

/** PLAN §8 Corpus row (`corpus` table, `schema.sql` — written by the not-yet-built `POST /corpora` pipeline; T-016 only reads it). */
export type CorpusRow = {
  corpusId: string;
  orgId: string;
  manifest: string;
  corpusManifestHash: Hex;
  corpusRoot: Hex;
  manifestLeafHash: Hex | null;
  manifestLeafIdx: number | null;
  onChainId: string | null;
  status: "draft" | "logged" | "sealed" | "closed";
  containsRevoked: boolean;
  createdAt: number;
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
