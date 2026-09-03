/**
 * T-015 — content-addressed bundle store (PLAN §14: "interface with
 * local-disk and S3 implementations; key = keccak hex; immutable; delivery
 * via short-lived signed URLs").
 *
 * Objects are addressed by their keccak256 hex hash (a `Hex32`, PLAN §8
 * `Upload.hash`). `put` always verifies the bytes it received hash to the
 * claimed key and total the claimed length before the object becomes
 * visible (`has`/`open`) — never a partial or mismatched object (D-4/D-18:
 * the server commits to files exactly as delivered, so it must never
 * silently accept the wrong ones).
 */
import type { Hex } from "viem";
import { hashStream } from "../../../../packages/protocol/src/payload.ts";

export class HashMismatchError extends Error {
  readonly reason = "hash_mismatch" as const;
  constructor(
    readonly expectedHash: Hex,
    readonly actualHash: Hex,
    readonly expectedBytes: number,
    readonly actualBytes: number,
  ) {
    super(
      `hash mismatch for ${expectedHash}: got ${actualHash} (${actualBytes} bytes, expected ${expectedBytes})`,
    );
  }
}

export interface BundleStore {
  /**
   * Streams `stream` into the store under `hash`, verifying (before the
   * object becomes visible) that its keccak256 equals `hash` and its byte
   * count equals `bytes`. On a mismatch the partial write is discarded and
   * `HashMismatchError` is thrown; on success the write is idempotent —
   * putting the same hash twice is a no-op the second time.
   */
  put(hash: Hex, stream: AsyncIterable<Uint8Array>, bytes: number): Promise<void>;
  has(hash: Hex): Promise<boolean>;
  open(hash: Hex): Promise<ReadableStream<Uint8Array>>;
  signedGetUrl(hash: Hex, ttlS: number): Promise<string>;
  signedPutUrl?(hash: Hex, bytes: number, ttlS: number): Promise<string>;
}
