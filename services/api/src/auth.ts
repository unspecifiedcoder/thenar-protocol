/**
 * `Authorization: Bearer <org API key>` — PLAN §12. Keys live in an
 * in-memory map loaded from `API_KEYS_JSON` (T-024 replaces this with the
 * `api_key` table). Only the sha256 of the key is ever held, and the
 * presented key is compared with `crypto.timingSafeEqual` so a timing
 * side-channel cannot narrow down a valid key byte by byte.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { ApiError } from "./errors.ts";

export type Role = "supplier" | "buyer" | "verifier" | "operator";

export type ApiKeyRecord = {
  key_sha256: string;
  org_id: string;
  role: Role;
};

export type Principal = { orgId: string; role: Role };

export function loadApiKeys(json: string | undefined): ApiKeyRecord[] {
  if (!json) return [];
  const parsed = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("API_KEYS_JSON must be a JSON array");
  for (const rec of parsed) {
    if (typeof rec?.key_sha256 !== "string" || typeof rec?.org_id !== "string" || typeof rec?.role !== "string") {
      throw new Error("API_KEYS_JSON entries need key_sha256, org_id, role");
    }
  }
  return parsed as ApiKeyRecord[];
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/** Constant-time compare of two hex digests of equal expected length. */
function safeHexEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export class KeyStore {
  constructor(private keys: ApiKeyRecord[]) {}

  /** Look up the presented bearer key. Every stored key is compared (not short-circuited) to avoid leaking which prefix matched. */
  authenticate(presented: string): Principal | null {
    const digest = sha256Hex(presented);
    let found: ApiKeyRecord | null = null;
    for (const rec of this.keys) {
      if (safeHexEqual(digest, rec.key_sha256)) found = rec;
    }
    if (!found) return null;
    return { orgId: found.org_id, role: found.role };
  }
}

/** Extracts and authenticates the bearer key. Throws `unauthorized` if missing/invalid. */
export function requireAuth(keyStore: KeyStore, authorizationHeader: string | undefined | null): Principal {
  const header = authorizationHeader ?? "";
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) throw new ApiError("unauthorized", "missing or malformed Authorization header");
  const principal = keyStore.authenticate(match[1]);
  if (!principal) throw new ApiError("unauthorized", "invalid API key");
  return principal;
}

/** PLAN §12: `/claims` requires a key with role `verifier`; an org acts only on its own rows. */
export function requireRole(principal: Principal, role: Role) {
  if (principal.role !== role) throw new ApiError("forbidden", `requires role ${role}`);
}

export function requireOwnOrg(principal: Principal, orgId: string) {
  if (principal.orgId !== orgId) throw new ApiError("forbidden", "may only act on its own organisation's rows");
}
