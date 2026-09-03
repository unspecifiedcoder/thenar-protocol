/**
 * HMAC-signed download tokens for the local `BundleStore`'s
 * `signedGetUrl`/`signedPutUrl` (PLAN §14 "delivery via short-lived signed
 * URLs"; T-015 binding rules). The URL shape is `/v1/uploads/{hash}?exp=
 * <unixSeconds>&t=<hmacHex>`, `t` = `HMAC-SHA256(secret, "<hash>:<exp>")`.
 * S3 has no need of this — it gets real presigned URLs from AWS.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Hex } from "viem";

export function signDownloadToken(hash: Hex, expiresAt: number, secret: string): string {
  return createHmac("sha256", secret).update(`${hash.toLowerCase()}:${expiresAt}`).digest("hex");
}

/** Constant-time verification; also rejects an expired `expiresAt`. */
export function verifyDownloadToken(
  hash: Hex,
  expiresAt: number,
  token: string,
  secret: string,
  now = Math.floor(Date.now() / 1000),
): boolean {
  if (now > expiresAt) return false;
  if (!/^[0-9a-f]+$/i.test(token)) return false;
  const expected = signDownloadToken(hash, expiresAt, secret);
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(token, "hex");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
