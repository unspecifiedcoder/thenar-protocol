/**
 * `Idempotency-Key` on every POST (PLAN §12, 24h). Same key + same body ->
 * replay the stored response verbatim. Same key + a different body -> 409
 * `conflict`, because silently answering with the first request's result
 * for a different payload would be a fabricated success (I-11).
 */
import { createHash } from "node:crypto";
import { ApiError } from "./errors.ts";

export type StoredResponse = { status: number; body: unknown };

export interface IdempotencyStore {
  get(key: string): StoredResponse & { bodyHash: string } | undefined;
  set(key: string, bodyHash: string, response: StoredResponse): void;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

type Entry = { bodyHash: string; status: number; body: unknown; expiresAt: number };

/** Default in-memory store. A real deployment can supply a DB-backed one behind the same interface. */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private entries = new Map<string, Entry>();
  constructor(private ttlMs = DEFAULT_TTL_MS) {}

  private sweep(now: number) {
    for (const [k, v] of this.entries) if (v.expiresAt <= now) this.entries.delete(k);
  }

  get(key: string) {
    const now = Date.now();
    this.sweep(now);
    const e = this.entries.get(key);
    if (!e) return undefined;
    return { bodyHash: e.bodyHash, status: e.status, body: e.body };
  }

  set(key: string, bodyHash: string, response: StoredResponse) {
    this.entries.set(key, { bodyHash, status: response.status, body: response.body, expiresAt: Date.now() + this.ttlMs });
  }
}

export function hashBody(body: unknown): string {
  return createHash("sha256").update(JSON.stringify(body ?? null)).digest("hex");
}

/**
 * Resolves an idempotency key against `store` before `handler` runs.
 * Returns the replayed response if one exists, throws `conflict` on a body
 * mismatch, and otherwise runs `handler` and stores its result.
 */
export async function withIdempotency(
  store: IdempotencyStore,
  key: string | undefined | null,
  body: unknown,
  handler: () => Promise<StoredResponse>,
): Promise<StoredResponse> {
  if (!key) return handler();
  const bodyHash = hashBody(body);
  const existing = store.get(key);
  if (existing) {
    if (existing.bodyHash !== bodyHash) {
      throw new ApiError("conflict", "Idempotency-Key was already used with a different request body");
    }
    return { status: existing.status, body: existing.body };
  }
  const result = await handler();
  store.set(key, bodyHash, result);
  return result;
}
