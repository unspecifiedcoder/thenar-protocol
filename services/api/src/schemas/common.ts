/**
 * Shared zod primitives for every PLAN §9 schema.
 *
 * Every schema built on top of `strictObject` here is closed: an unknown
 * key is rejected rather than dropped. That is I-7's guard against a
 * `chain_id` sneaking into a manifest or any other object that must carry
 * no chain-specific data.
 */
import { z } from "zod";

export const Hex32 = z
  .string()
  .regex(/^0x[0-9a-f]{64}$/, "must be 0x + 64 lowercase hex chars");

export const HexBytes = z
  .string()
  .regex(/^0x[0-9a-f]*$/, "must be 0x-prefixed lowercase hex");

export const ULID = z
  .string()
  .regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, "must be a 26-char Crockford base32 ULID");

export const UnixSeconds = z.number().int().nonnegative();

export const Alg = z.enum(["ed25519", "p256", "secp256k1"]);

export const strictObject = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict();

/** Compare two strings by their UTF-8 byte sequence, not UTF-16 code units. */
export function utf8Compare(a: string, b: string): number {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return Buffer.compare(ba, bb);
}

/** D-28: set-like arrays are sorted by the stated key and reject unsorted or duplicate entries. */
export function sortedUniqueBy<T>(items: T[], key: (item: T) => string, cmp: (a: string, b: string) => number) {
  for (let i = 1; i < items.length; i++) {
    const prev = key(items[i - 1]);
    const cur = key(items[i]);
    const c = cmp(prev, cur);
    if (c === 0) return { ok: false as const, reason: `duplicate entry at index ${i}` };
    if (c > 0) return { ok: false as const, reason: `entries not sorted at index ${i}` };
  }
  return { ok: true as const };
}

/**
 * §9.1 path rule: relative, `/`-separated, no `..` segment, no leading `/`,
 * no byte 0x1f, first byte in `[A-Za-z0-9]`.
 */
export function isValidManifestPath(path: string): boolean {
  if (path.length === 0) return false;
  if (!/^[A-Za-z0-9]/.test(path)) return false;
  if (path.includes("\x1f")) return false;
  const segments = path.split("/");
  if (segments.some((s) => s === "..")) return false;
  if (segments.some((s) => s === "")) return false;
  return true;
}

export const FileEntry = strictObject({
  path: z.string().refine(isValidManifestPath, "invalid manifest path"),
  bytes: z.number().int().nonnegative(),
  hash: Hex32,
});
export type FileEntry = z.infer<typeof FileEntry>;

export const Signature = strictObject({
  alg: Alg,
  key_id: Hex32,
  sig: HexBytes,
});
