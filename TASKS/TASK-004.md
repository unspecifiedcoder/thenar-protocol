# T-004 — Per-episode consent record, consent key, signed revocation (Ed25519 + P-256)

**Tier:** STRONG. Signature verification and key derivation on the revocation
path (D-7, D-19, D-26, I-3, I-6).

## Objective
Implement PLAN §9.4, §10.5, §10.6: consent records (one per episode),
`consentKey`, commitments, the four signature domains for Ed25519 and
P-256, and make `LogStore.revoke` require a valid signature.

## Dependencies
T-001.

## Files
- Create `packages/protocol/src/consent.ts`, `packages/protocol/src/sign.ts`, `packages/protocol/test/consent.ts` (register).
- Modify `services/log/src/store.ts` (`revoke(record, signature)`; no unsigned path exported), `services/log/test/log.test.ts`.
- Deps in `packages/protocol`: `@noble/ed25519`, `@noble/curves` (p256), `@noble/hashes`.

## Interfaces
```ts
export type ConsentRecord = { v: 1; kind: "consent_record"; holder: "contributor"|"organisation"; pubkey: Hex; alg: "ed25519"|"p256"; scope_bits: number; terms_hash: Hex; granted_at: number; nonce: Hex };
export function newConsentRecord(input: Omit<ConsentRecord, "v"|"kind"|"nonce">): ConsentRecord;   // fresh 16-byte nonce
export function recordHash(r: ConsentRecord): Hex;                       // hashObject
export function consentKey(recordHash: Hex): Hex;                        // keccak256(0x02 ‖ recordHash)
export function consentCommitment(recordHash: Hex, salt32: Hex): Hex;    // keccak256(recordHash ‖ salt)
export function revocationValue(recordHash: Hex): Hex;                   // keccak256(recordHash ‖ utf8("revoked"))
// sign.ts
export const DOMAINS = { manifest: "THENAR/v1/manifest", revoke: "THENAR/v1/revoke", claim: "THENAR/v1/claim", appendReceipt: "THENAR/v1/append-receipt" } as const;
export function message(domain: keyof typeof DOMAINS, objectHash: Hex): Uint8Array;   // utf8(domain) ‖ 0x00 ‖ objectHash
export async function sign(alg, domain, objectHash, privKey: Hex): Promise<Hex>;
export async function verify(alg, domain, objectHash, sig: Hex, pubkey: Hex): Promise<boolean>;
export function keyId(pubkey: Hex): Hex;                                 // keccak256(pubkey bytes as encoded)
// store.ts
revoke(record: ConsentRecord, signature: Hex): Promise<{ consentKey: Hex; value: Hex }>
```

## Expected behaviour
- `p256`: ECDSA over SHA-256(message); pubkey 65-byte uncompressed; sig
  `r‖s` 64 bytes; reject high-S. `ed25519`: strict verify (noble default).
- `revoke`: recompute `recordHash`/`consentKey`; verify `signature` with
  `record.alg`/`record.pubkey` over `message("revoke", consentKey)`; insert
  `(consentKey, revocationValue)`; idempotent on repeat.
- Wrong domain, wrong key, wrong alg, malformed key → `verify` false;
  `revoke` throws and writes nothing.
- Salt and record are **never** stored by the store.

## Edge cases
`nonce` ≠ 16 bytes → reject; two records for the same holder differ in
`consentKey` (unlinkability test); signature for episode A presented for B
fails (different consentKey).

## Tests
RFC 8032 vector sanity; P-256 known-answer (Wycheproof subset or RFC 6979
vector); THENAR-domain vectors (emitted by T-008); revoke negative cases;
existing SMT/onset tests migrated to signed revocations.

## Acceptance
`pnpm test:log`, `pnpm test:protocol` green; no unsigned revoke reachable.

## Security
Key custody is the holder's; loss ⇒ cannot revoke (documented in T-022).
