/**
 * Organisation and signing-key registry (T-024).
 *
 * Backs PLAN §8's `Organisation`/`SigningKey` rows and §12's three
 * `/orgs/{orgId}/keys*` routes, and is the sole source `resolveKey` reads
 * from for every signature check (D-20, I-14; T-020/T-021/T-036). Talks to
 * the `org`, `api_key` and `signing_key` tables (`services/log`, T-014)
 * exclusively through `ILogStore` — no SQLite opened here.
 */
import { randomBytes } from "node:crypto";
import { keccak256, type Hex } from "viem";
import { ApiError } from "./errors.ts";
import { sha256Hex } from "./auth.ts";
import type { Role } from "./auth.ts";
import type { ILogStore, OrgRow, ApiKeyRow, SigningKeyRow } from "../../log/src/store-interface.ts";

export type OrgKind = "supplier" | "buyer" | "verifier";
export type Alg = "ed25519" | "p256" | "secp256k1";

/** §10.6/T-024: pubkey byte lengths accepted per algorithm. */
const PUBKEY_BYTE_LENGTHS: Record<Alg, number[]> = {
  ed25519: [32],
  p256: [65],
  secp256k1: [33, 65],
};

function hexByteLength(hex: string): number {
  return (hex.length - 2) / 2;
}

/** Validates a pubkey's length (and, where applicable, its uncompressed-SEC1 prefix) per §10.6/T-024. Throws `invalid_request`. */
export function validatePubkey(alg: Alg, pubkey: Hex): void {
  const len = hexByteLength(pubkey);
  const allowed = PUBKEY_BYTE_LENGTHS[alg];
  if (!allowed.includes(len)) {
    throw new ApiError("invalid_request", `${alg} pubkey must be ${allowed.join(" or ")} bytes, got ${len}`);
  }
  if ((alg === "p256" || (alg === "secp256k1" && len === 65)) && !pubkey.toLowerCase().startsWith("0x04")) {
    throw new ApiError("invalid_request", `${alg} uncompressed pubkey must start 0x04`);
  }
}

/**
 * §1.1/D-30: who an attestation vouches for. Default `"signer_device"` —
 * a phone's secure element attests the signer's own device, never the
 * robot; only `"robot_controller"` can ever satisfy the `attestedPhysical`
 * rule (`packages/protocol/src/wording.ts` `isAttestedPhysical`).
 */
export type AttestationSubject = "signer_device" | "robot_controller";

/**
 * Shape of the `attestation` blob `registerKey` accepts and stores
 * (raw JSON, T-023 verification not built yet — see `registerKey` below).
 * `subject` is new in T-040; `level` stays reported as 1 by `listKeys`
 * regardless of what is stored here (T-023 not built).
 */
export type SigningKeyAttestation = {
  level?: number;
  subject?: AttestationSubject;
  manufacturer?: string;
  model?: string;
  [key: string]: unknown;
};

/** PLAN §12 `GET /orgs/{orgId}/keys` shape — no attestation blob. */
export type PublicSigningKey = {
  key_id: Hex;
  alg: Alg;
  pubkey: Hex;
  valid_from: number;
  valid_to: number | null;
  attestation_level: number;
};

/** The §12 response shape, shared by the create, revoke and list routes. */
export function toPublicSigningKey(row: SigningKeyRow): PublicSigningKey {
  return {
    key_id: row.keyId,
    alg: row.alg as Alg,
    pubkey: row.pubkey,
    valid_from: row.validFrom,
    valid_to: row.validTo,
    attestation_level: 1,
  };
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeCrockford(num: bigint, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) {
    s = CROCKFORD[Number(num & 31n)] + s;
    num >>= 5n;
  }
  return s;
}

/** A ULID (§8 identifier convention): 48-bit millis timestamp + 80 bits of randomness, Crockford base32. */
export function newUlid(now: number = Date.now()): string {
  const timePart = encodeCrockford(BigInt(now), 10);
  let randNum = 0n;
  for (const b of randomBytes(10)) randNum = (randNum << 8n) | BigInt(b);
  const randPart = encodeCrockford(randNum, 16);
  return timePart + randPart;
}

export class Registry {
  constructor(private store: ILogStore, private now: () => number = () => Math.floor(Date.now() / 1000)) {}

  /** Get the backing log store (T-012, T-024). */
  getStore(): ILogStore {
    return this.store;
  }

  createOrg(name: string, kind: OrgKind): OrgRow {
    const row: OrgRow = { orgId: newUlid(), name, kind, status: "active", createdAt: this.now() };
    this.store.createOrg(row);
    return row;
  }

  getOrg(orgId: string): OrgRow | null {
    return this.store.org(orgId);
  }

  /** Returns the plaintext key once; only its sha256 digest is stored (auth.ts). */
  issueApiKey(orgId: string, role: Role): { key_id: string; org_id: string; role: Role; plaintext_key: string } {
    if (!this.store.org(orgId)) throw new ApiError("not_found", `org ${orgId} does not exist`);
    const plaintext = randomBytes(32).toString("hex");
    const row: ApiKeyRow = {
      keyId: newUlid(), orgId, keyHash: sha256Hex(plaintext), role, createdAt: this.now(), revokedAt: null,
    };
    this.store.insertApiKey(row);
    return { key_id: row.keyId, org_id: orgId, role, plaintext_key: plaintext };
  }

  /** §10.6 `keyId = H(pubkeyBytes)`; 409 if that pubkey is already registered (edge case, same key twice). */
  registerKey(orgId: string, params: { alg: Alg; pubkey: Hex; attestation?: SigningKeyAttestation }): SigningKeyRow {
    if (!this.store.org(orgId)) throw new ApiError("not_found", `org ${orgId} does not exist`);
    validatePubkey(params.alg, params.pubkey);
    const keyId = keccak256(params.pubkey);
    if (this.store.signingKey(keyId)) {
      throw new ApiError("conflict", `signing key for this pubkey is already registered`);
    }
    // §1.1/D-30: `subject` defaults to "signer_device" — an attestation
    // that doesn't say what it vouches for is assumed to attest the
    // signer's own device, never the robot (only an explicit
    // "robot_controller" can ever satisfy `attestedPhysical`).
    const attestationToStore = params.attestation === undefined
      ? undefined
      : { subject: "signer_device" as const, ...params.attestation };
    const row: SigningKeyRow = {
      keyId,
      orgId,
      alg: params.alg,
      pubkey: params.pubkey,
      validFrom: this.now(),
      validTo: null,
      // Attestation is accepted and kept, but T-023 (attestation roots/
      // verification) doesn't exist yet, so `listKeys` reports level 1
      // unconditionally (never 2) rather than trusting an unverified claim.
      attestation: attestationToStore === undefined ? null : JSON.stringify(attestationToStore),
      status: "active",
    };
    this.store.insertSigningKey(row);
    return row;
  }

  /** Sets `validTo = now` once; 409 if the key was already revoked (edge case). */
  revokeKey(orgId: string, keyId: Hex): SigningKeyRow {
    const row = this.store.signingKey(keyId);
    if (!row || row.orgId !== orgId) throw new ApiError("not_found", `signing key not found for org ${orgId}`);
    if (row.validTo !== null) throw new ApiError("conflict", "signing key already revoked");
    const validTo = this.now();
    this.store.revokeSigningKey(keyId, validTo);
    return { ...row, validTo, status: "revoked" };
  }

  /** D-20/I-14: the key iff `validFrom <= at < validTo` (or `validTo` unset, i.e. still active). */
  resolveKey(keyId: Hex, at: number): SigningKeyRow | null {
    const row = this.store.signingKey(keyId);
    if (!row) return null;
    if (at < row.validFrom) return null;
    if (row.validTo !== null && at >= row.validTo) return null;
    return row;
  }

  /** Public shape (PLAN §12) — omits `attestation`. */
  listKeys(orgId: string): PublicSigningKey[] {
    return this.store.signingKeysForOrg(orgId).map(toPublicSigningKey);
  }
}
