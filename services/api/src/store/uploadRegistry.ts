/**
 * PLAN §8 `Upload` row (`hash`, `bytes`, `orgId`, `status: pending|stored`),
 * tracked in memory until T-014 backs this with the SQLite `upload` table
 * (PLAN §14). Kept deliberately small so that swap is a drop-in.
 */
import type { Hex } from "viem";

export type UploadRecord = {
  hash: Hex;
  bytes: number;
  orgId: string;
  status: "pending" | "stored";
};

export interface UploadRegistry {
  get(hash: Hex): Promise<UploadRecord | undefined>;
  /** Registers a pending upload. If a record already exists for `hash`, it is left untouched (duplicate concurrent uploads share one row). */
  putPending(hash: Hex, bytes: number, orgId: string): Promise<UploadRecord>;
  markStored(hash: Hex): Promise<void>;
}

export class MemoryUploadRegistry implements UploadRegistry {
  private rows = new Map<string, UploadRecord>();

  async get(hash: Hex): Promise<UploadRecord | undefined> {
    return this.rows.get(hash.toLowerCase());
  }

  async putPending(hash: Hex, bytes: number, orgId: string): Promise<UploadRecord> {
    const key = hash.toLowerCase();
    const existing = this.rows.get(key);
    if (existing) return existing;
    const record: UploadRecord = { hash, bytes, orgId, status: "pending" };
    this.rows.set(key, record);
    return record;
  }

  async markStored(hash: Hex): Promise<void> {
    const key = hash.toLowerCase();
    const existing = this.rows.get(key);
    if (existing) {
      existing.status = "stored";
    } else {
      this.rows.set(key, { hash, bytes: 0, orgId: "", status: "stored" });
    }
  }
}
