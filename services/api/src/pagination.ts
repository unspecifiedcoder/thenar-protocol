/**
 * Cursor pagination (PLAN §12): `?cursor=&limit=` (default 50, max 500),
 * responses `{ items, next_cursor }`. The cursor is opaque to the caller —
 * a base64url encoding of `{ k: sortKey, id }` — so callers can't construct
 * one by hand or depend on its shape (I-9: interfaces change only by ADR).
 */
import { ApiError } from "./errors.ts";

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;

export type Cursor = { k: string; id: string };

export function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

export function decodeCursor(raw: string): Cursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw new ApiError("invalid_request", "malformed cursor");
  }
  if (
    typeof parsed !== "object" || parsed === null ||
    typeof (parsed as Cursor).k !== "string" || typeof (parsed as Cursor).id !== "string"
  ) {
    throw new ApiError("invalid_request", "malformed cursor");
  }
  return parsed as Cursor;
}

/** Parses `limit` query param per PLAN §12 defaults/bounds. */
export function parseLimit(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new ApiError("invalid_request", "limit must be a positive integer");
  return Math.min(n, MAX_LIMIT);
}

export function paginated<T>(items: T[], nextCursor: Cursor | null) {
  return { items, next_cursor: nextCursor ? encodeCursor(nextCursor) : null };
}
