import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Hex } from "viem";
import * as ct from "../../../packages/protocol/src/log.ts";

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

export class LogStore {
  private db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS leaf (
        idx           INTEGER PRIMARY KEY,
        leaf          TEXT NOT NULL UNIQUE,
        preimage      TEXT,
        task_id       TEXT,
        contributor   TEXT,
        quality_score INTEGER,
        success       INTEGER,
        created_at    INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS anchor (
        idx             INTEGER PRIMARY KEY,
        root            TEXT NOT NULL,
        size            INTEGER NOT NULL,
        revocation_root TEXT NOT NULL,
        tx_hash         TEXT,
        block_number    INTEGER,
        created_at      INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS revocation (
        consent_key TEXT PRIMARY KEY,
        value       TEXT NOT NULL,
        created_at  INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS leaf_task ON leaf(task_id);
    `);
  }

  /** Append a leaf. Returns its index. A duplicate leaf is refused, not silently reindexed. */
  append(leaf: Hex, meta: Partial<Omit<StoredLeaf, "index" | "leaf" | "createdAt">> = {}): number {
    const existing = this.db.prepare("SELECT idx FROM leaf WHERE leaf = ?").get(leaf) as { idx: number } | undefined;
    if (existing) throw new Error(`leaf already in the log at index ${existing.idx}`);
    const idx = this.size();
    this.db.prepare(
      `INSERT INTO leaf (idx, leaf, preimage, task_id, contributor, quality_score, success, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(idx, leaf, meta.preimage ?? null, meta.taskId ?? null, meta.contributor ?? null,
          meta.qualityScore ?? null, meta.success ?? null, Date.now());
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
    return { index: r.idx, leaf: r.leaf, preimage: r.preimage, taskId: r.task_id,
             contributor: r.contributor, qualityScore: r.quality_score, success: r.success,
             createdAt: r.created_at };
  }

  indexOfLeaf(leaf: Hex): number | null {
    const r = this.db.prepare("SELECT idx FROM leaf WHERE leaf = ?").get(leaf) as { idx: number } | undefined;
    return r ? r.idx : null;
  }

  byTask(taskId: Hex): StoredLeaf[] {
    const rows = this.db.prepare("SELECT * FROM leaf WHERE task_id = ? ORDER BY idx ASC").all(taskId) as any[];
    return rows.map((r) => ({ index: r.idx, leaf: r.leaf, preimage: r.preimage, taskId: r.task_id,
      contributor: r.contributor, qualityScore: r.quality_score, success: r.success, createdAt: r.created_at }));
  }

  /** Root of the whole log, or of its first `upTo` leaves. */
  root(upTo?: number): Hex {
    return ct.root(this.leaves(upTo));
  }

  inclusionProof(index: number, size?: number): Hex[] {
    return ct.inclusionProof(this.leaves(size), index);
  }

  consistencyProof(m: number, n?: number): Hex[] {
    const to = n ?? this.size();
    return ct.consistencyProof(this.leaves(to), m, to);
  }

  // ------------------------------------------------------------- revocations

  revoke(consentKey: Hex, value: Hex) {
    this.db.prepare("INSERT OR REPLACE INTO revocation (consent_key, value, created_at) VALUES (?, ?, ?)")
      .run(consentKey, value, Date.now());
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

  close() { this.db.close(); }
}
