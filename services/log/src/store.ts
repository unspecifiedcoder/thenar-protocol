import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hex } from "viem";
import * as tree from "./tree.ts";
import { recordHash, consentKey as deriveConsentKey, revocationValue, type ConsentRecord } from "../../../packages/protocol/src/consent.ts";
import { verify as verifySignature } from "../../../packages/protocol/src/sign.ts";
import type { ILogStore, EpisodeMeta, ClaimRow, OrgRow, ApiKeyRow, SigningKeyRow } from "./store-interface.ts";

/**
 * The log itself — one append-only tree, persisted.
 *
 * Every ad-hoc script that built its own batch tree and then anchored a
 * cumulative size produced an anchor whose root and size disagreed, against
 * which no proof can ever verify. The log has to be one growing tree that
 * retains every leaf, and that is what this owns.
 *
 * SQLite because the leaves must survive a restart: a log that forgets is not
 * a log, and an anchor pointing at a tree nobody can rebuild proves nothing.
 *
 * Root/inclusion/consistency read from the `node` cache (`tree.ts`, T-014)
 * rather than replaying every leaf (PLAN Sec10.1, D-24) — O(log n) instead
 * of O(n). `leaf`, `anchor`, `anchor_chain`, `revocation` and `claim` all
 * reject UPDATE and DELETE outright (`schema.sql` triggers) — provenance
 * cannot be rewritten (PLAN Sec5 I-2).
 */
export type StoredLeaf = {
  index: number;
  leaf: Hex;
  preimage: Hex | null;
  taskId: Hex | null;
  contributor: string | null;
  qualityScore: number | null;
  success: number | null;
  createdAt: number;
};

const SCHEMA_PATH = fileURLToPath(new URL("./schema.sql", import.meta.url));

function rowToStoredLeaf(r: any): StoredLeaf {
  return {
    index: r.idx, leaf: r.leaf, preimage: r.preimage, taskId: r.task_id,
    contributor: r.contributor, qualityScore: r.quality_score, success: r.success,
    createdAt: r.created_at,
  };
}

export class LogStore implements ILogStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  }

  /**
   * Append a leaf and, in the same transaction, update the `node` cache's
   * complete-subtree path (`tree.cacheAppend`). `BEGIN IMMEDIATE` (rather
   * than the default deferred `BEGIN`) claims the write lock up front, so a
   * crash between the two inserts always rolls back both — the `leaf` table
   * and the `node` cache never observe each other's writes without the
   * other. A duplicate leaf is refused, not silently reindexed.
   */
  append(leaf: Hex, meta: Partial<Omit<StoredLeaf, "index" | "leaf" | "createdAt">> = {}): number {
    const existing = this.db.prepare("SELECT idx FROM leaf WHERE leaf = ?").get(leaf) as { idx: number } | undefined;
    if (existing) throw new Error(`leaf already in the log at index ${existing.idx}`);
    const idx = this.size();
    const m = meta as Record<string, unknown>;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(
        `INSERT INTO leaf (idx, leaf, preimage, task_id, contributor, quality_score, success,
                            manifest, manifest_hash, payload_hash, dataset_id, org_id, consent_key,
                            submitted_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        idx, leaf, meta.preimage ?? null, meta.taskId ?? null, meta.contributor ?? null,
        meta.qualityScore ?? null, meta.success ?? null,
        (m.manifest as string | undefined) ?? null, (m.manifestHash as string | undefined) ?? null,
        (m.payloadHash as string | undefined) ?? null, (m.datasetId as string | undefined) ?? null,
        (m.orgId as string | undefined) ?? null, (m.consentKey as string | undefined) ?? null,
        (m.submittedAt as number | undefined) ?? null, Date.now(),
      );
      tree.cacheAppend(this.db, idx, leaf);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return idx;
  }

  size(): number {
    const r = this.db.prepare("SELECT COUNT(*) AS n FROM leaf").get() as { n: number };
    return r.n;
  }

  leaves(upTo?: number): Hex[] {
    const n = upTo ?? this.size();
    const rows = this.db.prepare("SELECT leaf FROM leaf WHERE idx < ? ORDER BY idx ASC").all(n) as { leaf: string }[];
    return rows.map((r) => r.leaf as Hex);
  }

  leafAt(index: number): StoredLeaf | null {
    const r = this.db.prepare("SELECT * FROM leaf WHERE idx = ?").get(index) as any;
    if (!r) return null;
    return rowToStoredLeaf(r);
  }

  indexOfLeaf(leaf: Hex): number | null {
    const r = this.db.prepare("SELECT idx FROM leaf WHERE leaf = ?").get(leaf) as { idx: number } | undefined;
    return r ? r.idx : null;
  }

  byTask(taskId: Hex): StoredLeaf[] {
    const rows = this.db.prepare("SELECT * FROM leaf WHERE task_id = ? ORDER BY idx ASC").all(taskId) as any[];
    return rows.map(rowToStoredLeaf);
  }

  // ------------------------------------------------------------------ proofs

  /** Root of the whole log, or of its first `upTo` leaves — from the `node` cache, O(log n). */
  root(upTo?: number): Hex {
    return tree.root(this.db, this.size(), upTo);
  }

  inclusionProof(index: number, size?: number): Hex[] {
    return tree.inclusionProof(this.db, index, size ?? this.size());
  }

  consistencyProof(m: number, n?: number): Hex[] {
    return tree.consistencyProof(this.db, m, n ?? this.size());
  }

  // ------------------------------------------------------------- revocations

  /**
   * Verifies `signature` over `message("revoke", consentKey)` (PLAN Sec10.6)
   * against `record.pubkey`/`record.alg` before inserting anything — an
   * unsigned or wrongly-signed revocation must write nothing (PLAN Sec5
   * I-3/I-6, Sec27 trap #8). Idempotent: repeating the same signed
   * revocation is a no-op re-insert, not an error.
   *
   * The record and the salt are never persisted (PLAN Sec10.5) — only the
   * derived `(consentKey, value)` pair goes into the `revocation` table.
   */
  async revoke(record: ConsentRecord, signature: Hex): Promise<{ consentKey: Hex; value: Hex }> {
    const hash = recordHash(record);
    const key = deriveConsentKey(hash);
    const value = revocationValue(hash);
    const valid = await verifySignature(record.alg, "revoke", key, signature, record.pubkey);
    if (!valid) throw new Error("revoke: invalid signature");
    this._revokeUnchecked(key, value);
    return { consentKey: key, value };
  }

  /**
   * Test-only escape hatch: writes a `(consentKey, value)` revocation pair
   * with no signature check. Never called from production code paths — the
   * only public, signature-verifying entry point is `revoke` above.
   */
  _revokeUnchecked(consentKey: Hex, value: Hex) {
    this.db.prepare("INSERT OR REPLACE INTO revocation (consent_key, value, received_at, created_at) VALUES (?, ?, ?, ?)")
      .run(consentKey, value, Date.now(), Date.now());
  }

  revocations(): { consentKey: Hex; value: Hex }[] {
    const rows = this.db.prepare("SELECT consent_key, value FROM revocation").all() as any[];
    return rows.map((r) => ({ consentKey: r.consent_key as Hex, value: r.value as Hex }));
  }

  // ----------------------------------------------------------------- anchors

  /**
   * Record an anchor. `size` is always the log's true size, so root and size
   * are coherent by construction — the incoherence that made anchors
   * unverifiable is not expressible through this API.
   */
  recordAnchor(idx: number, root: Hex, size: number, revocationRoot: Hex, txHash: string, blockNumber: number) {
    this.db.prepare(
      `INSERT OR REPLACE INTO anchor (idx, root, size, revocation_root, tx_hash, block_number, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(idx, root, size, revocationRoot, txHash, blockNumber, Date.now());
  }

  anchors(): { idx: number; root: Hex; size: number; revocationRoot: Hex; txHash: string; blockNumber: number }[] {
    const rows = this.db.prepare("SELECT * FROM anchor ORDER BY idx ASC").all() as any[];
    return rows.map((r) => ({ idx: r.idx, root: r.root, size: r.size,
      revocationRoot: r.revocation_root, txHash: r.tx_hash, blockNumber: r.block_number }));
  }

  lastAnchoredSize(): number {
    const r = this.db.prepare("SELECT MAX(size) AS s FROM anchor").get() as { s: number | null };
    return r.s ?? 0;
  }

  /** The legacy (primary-chain) anchor recorded for an exact `(root, size)`, or null. */
  anchorBy(root: Hex, size: number): { idx: number; root: Hex; size: number; revocationRoot: Hex; txHash: string; blockNumber: number } | null {
    const r = this.db.prepare("SELECT * FROM anchor WHERE root = ? AND size = ?").get(root, size) as any;
    if (!r) return null;
    return { idx: r.idx, root: r.root, size: r.size, revocationRoot: r.revocation_root, txHash: r.tx_hash, blockNumber: r.block_number };
  }

  // ------------------------------------------------------- per-chain anchors

  /**
   * Record one chain's anchor. Anchoring the same head to a primary and its
   * mirrors produces one `anchor_chain` row per chain — each with its own
   * on-chain index, tx hash and block number — alongside the single legacy
   * `anchor` row the primary writes (kept for callers that only know one
   * chain). There is no update/delete path here beyond replaying the same
   * `(chain_id, idx)`: a chain's anchor history is append-only.
   */
  recordAnchorChain(chainId: number, idx: number, root: Hex, size: number, revocationRoot: Hex, txHash: string, blockNumber: number) {
    this.db.prepare(
      `INSERT OR REPLACE INTO anchor_chain (chain_id, idx, root, size, revocation_root, block_number, tx_hash, at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(chainId, idx, root, size, revocationRoot, blockNumber, txHash, Date.now());
  }

  /** Anchors recorded for one chain (or every chain, when `chainId` is omitted), oldest first. */
  anchorsForChain(chainId?: number): {
    chainId: number; idx: number; root: Hex; size: number; revocationRoot: Hex | null; txHash: string; blockNumber: number;
  }[] {
    const rows = (
      chainId === undefined
        ? this.db.prepare("SELECT * FROM anchor_chain ORDER BY chain_id ASC, idx ASC").all()
        : this.db.prepare("SELECT * FROM anchor_chain WHERE chain_id = ? ORDER BY idx ASC").all(chainId)
    ) as any[];
    return rows.map((r) => ({
      chainId: r.chain_id, idx: r.idx, root: r.root, size: r.size, revocationRoot: r.revocation_root,
      txHash: r.tx_hash, blockNumber: r.block_number,
    }));
  }

  /** Every chain's anchor row for an exact `(root, size)`. */
  anchorChains(root: Hex, size: number): {
    chainId: number; idx: number; root: Hex; size: number; revocationRoot: Hex | null; txHash: string; blockNumber: number;
  }[] {
    const rows = this.db.prepare("SELECT * FROM anchor_chain WHERE root = ? AND size = ? ORDER BY chain_id ASC").all(root, size) as any[];
    return rows.map((r) => ({
      chainId: r.chain_id, idx: r.idx, root: r.root, size: r.size, revocationRoot: r.revocation_root,
      txHash: r.tx_hash, blockNumber: r.block_number,
    }));
  }

  /** The most recent (highest-idx) anchor recorded for `chainId`, or null if that chain has never anchored. */
  lastAnchored(chainId: number): { size: number; revocationRoot: Hex } | null {
    const r = this.db.prepare("SELECT size, revocation_root FROM anchor_chain WHERE chain_id = ? ORDER BY idx DESC LIMIT 1").get(chainId) as any;
    if (!r) return null;
    return { size: r.size, revocationRoot: r.revocation_root };
  }

  // ---------------------------------------------------------------- episodes

  /** The episode metadata (PLAN Sec8) recorded for a leaf, or null if that leaf was never appended. */
  episodeMeta(leafHash: Hex): EpisodeMeta | null {
    const r = this.db.prepare("SELECT * FROM leaf WHERE leaf = ?").get(leafHash) as any;
    if (!r) return null;
    return {
      ...rowToStoredLeaf(r),
      manifest: r.manifest ?? null,
      manifestHash: r.manifest_hash ?? null,
      payloadHash: r.payload_hash ?? null,
      datasetId: r.dataset_id ?? null,
      orgId: r.org_id ?? null,
      consentKey: r.consent_key ?? null,
      submittedAt: r.submitted_at ?? null,
    };
  }

  /** Episodes belonging to `orgId`, log-index order, paginated (PLAN Sec9 `{ items, next_cursor }`, capped at 500). */
  byOrg(orgId: string, cursor?: number, limit = 100): { items: StoredLeaf[]; nextCursor: number | null } {
    const cappedLimit = Math.min(Math.max(limit, 1), 500);
    const after = cursor ?? -1;
    const rows = this.db.prepare(
      "SELECT * FROM leaf WHERE org_id = ? AND idx > ? ORDER BY idx ASC LIMIT ?",
    ).all(orgId, after, cappedLimit + 1) as any[];
    const items = rows.slice(0, cappedLimit).map(rowToStoredLeaf);
    const nextCursor = rows.length > cappedLimit ? items[items.length - 1].index : null;
    return { items, nextCursor };
  }

  byDataset(datasetId: string): StoredLeaf[] {
    const rows = this.db.prepare("SELECT * FROM leaf WHERE dataset_id = ? ORDER BY idx ASC").all(datasetId) as any[];
    return rows.map(rowToStoredLeaf);
  }

  // ------------------------------------------------------------------ claims

  /** Record a VerificationClaim (PLAN Sec9.3) leaf's row. Insert-only — `claim` rejects UPDATE/DELETE. */
  recordClaim(claim: ClaimRow): void {
    this.db.prepare(
      `INSERT INTO claim (leaf_hash, subject_leaf, verifier_key_id, check_name, result, level_asserted,
                           detail, detail_hash, issued_at, signature, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      claim.leafHash, claim.subjectLeaf, claim.verifierKeyId, claim.check, claim.result,
      claim.levelAsserted ?? null, claim.detail, claim.detailHash, claim.issuedAt, claim.signature ?? null, Date.now(),
    );
  }

  claimsFor(leafHash: Hex): ClaimRow[] {
    const rows = this.db.prepare("SELECT * FROM claim WHERE subject_leaf = ? ORDER BY issued_at ASC").all(leafHash) as any[];
    return rows.map((r) => ({
      leafHash: r.leaf_hash, subjectLeaf: r.subject_leaf, verifierKeyId: r.verifier_key_id,
      check: r.check_name, result: r.result, levelAsserted: r.level_asserted,
      detail: r.detail, detailHash: r.detail_hash, issuedAt: r.issued_at, signature: r.signature,
    }));
  }

  // -------------------------------------------------- org / key registry (T-024)

  /** Insert-only — the `org` table has no update path (fields other than status are meant to be edited via a later task, not here). */
  createOrg(org: OrgRow): void {
    this.db.prepare(
      "INSERT INTO org (org_id, name, kind, status, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(org.orgId, org.name, org.kind, org.status, org.createdAt);
  }

  org(orgId: string): OrgRow | null {
    const r = this.db.prepare("SELECT * FROM org WHERE org_id = ?").get(orgId) as any;
    if (!r) return null;
    return { orgId: r.org_id, name: r.name, kind: r.kind, status: r.status, createdAt: r.created_at };
  }

  insertApiKey(row: ApiKeyRow): void {
    this.db.prepare(
      "INSERT INTO api_key (key_id, org_id, key_hash, role, created_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(row.keyId, row.orgId, row.keyHash, row.role, row.createdAt, row.revokedAt ?? null);
  }

  /** Looked up by the sha256 digest of the presented bearer token (`auth.ts`), never the plaintext. */
  apiKeyByHash(keyHash: string): ApiKeyRow | null {
    const r = this.db.prepare("SELECT * FROM api_key WHERE key_hash = ?").get(keyHash) as any;
    if (!r) return null;
    return { keyId: r.key_id, orgId: r.org_id, keyHash: r.key_hash, role: r.role, createdAt: r.created_at, revokedAt: r.revoked_at };
  }

  /** `key_id` is the PK — a duplicate `keyId` (same pubkey, PLAN Sec10.6) throws, which callers turn into 409 (PLAN Sec12 edge case). */
  insertSigningKey(row: SigningKeyRow): void {
    this.db.prepare(
      `INSERT INTO signing_key (key_id, org_id, alg, pubkey, valid_from, valid_to, attestation, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(row.keyId, row.orgId, row.alg, row.pubkey, row.validFrom, row.validTo ?? null, row.attestation ?? null, row.status);
  }

  signingKey(keyId: Hex): SigningKeyRow | null {
    const r = this.db.prepare("SELECT * FROM signing_key WHERE key_id = ?").get(keyId) as any;
    if (!r) return null;
    return {
      keyId: r.key_id, orgId: r.org_id, alg: r.alg, pubkey: r.pubkey,
      validFrom: r.valid_from, validTo: r.valid_to, attestation: r.attestation, status: r.status,
    };
  }

  /**
   * Sets `valid_to` once (PLAN Sec8 SigningKey: append-only, `validTo` set
   * once). Unlike `leaf`/`anchor`/`revocation`/`claim`, `signing_key` has no
   * blanket append-only trigger — `registry.ts` is the sole gate that
   * refuses a second revoke (409) before this ever runs twice.
   */
  revokeSigningKey(keyId: Hex, validTo: number): void {
    this.db.prepare("UPDATE signing_key SET valid_to = ?, status = 'revoked' WHERE key_id = ?").run(validTo, keyId);
  }

  signingKeysForOrg(orgId: string): SigningKeyRow[] {
    const rows = this.db.prepare("SELECT * FROM signing_key WHERE org_id = ? ORDER BY valid_from ASC").all(orgId) as any[];
    return rows.map((r) => ({
      keyId: r.key_id, orgId: r.org_id, alg: r.alg, pubkey: r.pubkey,
      validFrom: r.valid_from, validTo: r.valid_to, attestation: r.attestation, status: r.status,
    }));
  }

  close() { this.db.close(); }
}
