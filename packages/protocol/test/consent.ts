/**
 * T-004 -- consent records, consent keys, and the four signed revocation
 * domains (PLAN Sec9.4, Sec10.5, Sec10.6).
 */
import { keccak256, toHex, toBytes, type Hex } from "viem";
import * as ed from "@noble/ed25519";
import { p256 } from "@noble/curves/nist.js";
import {
  newConsentRecord, recordHash, consentKey, consentCommitment, revocationValue,
  type ConsentRecord,
} from "../src/consent";
import { DOMAINS, message, sign, verify, keyId } from "../src/sign";

let fails = 0;
const ok = (c: boolean, m: string, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` -- ${x}` : ""}`); };
const h = (s: string): Hex => keccak256(toHex(s));

// =============================================================================
// RFC 8032 test vector 1 -- sanity check of the raw @noble/ed25519 library
// (https://www.rfc-editor.org/rfc/rfc8032#section-7.1, TEST 1). Independent of
// THENAR's own message framing.
// =============================================================================
{
  const secretKey = "0x9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60" as Hex;
  const publicKey = "0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a" as Hex;
  const sigExpected = "0xe5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b" as Hex;
  const msg = new Uint8Array(0);
  const sig = ed.sign(msg, toBytes(secretKey));
  ok(toHex(sig) === sigExpected, "RFC 8032 test vector 1: sign() reproduces the known signature");
  ok(ed.verify(sig, msg, toBytes(publicKey), { zip215: false }), "RFC 8032 test vector 1: verify() accepts it");
  ok(!ed.verify(sig, toBytes("0x01"), toBytes(publicKey), { zip215: false }),
     "RFC 8032 test vector 1: verify() rejects a different message");
}

// =============================================================================
// P-256: sign/verify round trip with a fixed key, plus high-S rejection.
// =============================================================================
{
  const secretKey = toHex(new Uint8Array(32).fill(0x42));
  ok(p256.utils.isValidSecretKey(toBytes(secretKey)), "the fixed P-256 test key is a valid scalar");
  const publicKey = toHex(p256.getPublicKey(toBytes(secretKey), false));
  ok(publicKey.length === 132, "an uncompressed P-256 public key is 65 bytes", `${(publicKey.length - 2) / 2} bytes`);

  const objectHash = h("p256-object");
  const sig = await sign("p256", "revoke", objectHash, secretKey);
  ok(sig.length === 130, "a P-256 signature is 64 bytes (compact r||s)", `${(sig.length - 2) / 2} bytes`);
  ok(await verify("p256", "revoke", objectHash, sig, publicKey), "the round-trip P-256 signature verifies");

  // Flip s -> n - s: still a mathematically valid ECDSA signature for the
  // same (message, key), but with high S -- the low-S policy must reject it.
  const P256_N = 115792089210356248762697446949407573529996955224135760342422259061068512044369n;
  const sigBytes = toBytes(sig);
  const r = sigBytes.slice(0, 32);
  const s = BigInt(toHex(sigBytes.slice(32, 64)));
  const sHigh = P256_N - s;
  ok(sHigh > P256_N / 2n, "the flipped s is actually high-S (sanity on the test itself)");
  const forged = new Uint8Array(64);
  forged.set(r, 0);
  forged.set(toBytes(toHex(sHigh, { size: 32 })), 32);
  ok(!(await verify("p256", "revoke", objectHash, toHex(forged), publicKey)),
     "a high-S P-256 signature is rejected");
}

// =============================================================================
// message(): THENAR-domain byte layout, hard-coded as hex, for all four
// domains (PLAN Sec10.6: utf8(domain) || 0x00 || objectHash).
// =============================================================================
{
  const vectors: [keyof typeof DOMAINS, Hex, Hex][] = [
    ["manifest", `0x${"01".repeat(32)}` as Hex,
      "0x5448454e41522f76312f6d616e6966657374000101010101010101010101010101010101010101010101010101010101010101" as Hex],
    ["revoke", `0x${"02".repeat(32)}` as Hex,
      "0x5448454e41522f76312f7265766f6b65000202020202020202020202020202020202020202020202020202020202020202" as Hex],
    ["claim", `0x${"03".repeat(32)}` as Hex,
      "0x5448454e41522f76312f636c61696d000303030303030303030303030303030303030303030303030303030303030303" as Hex],
    ["appendReceipt", `0x${"04".repeat(32)}` as Hex,
      "0x5448454e41522f76312f617070656e642d72656365697074000404040404040404040404040404040404040404040404040404040404040404" as Hex],
  ];
  for (const [domain, objectHash, expected] of vectors) {
    const got = toHex(message(domain, objectHash));
    ok(got === expected, `message("${domain}", …) matches the hard-coded THENAR vector`, got !== expected ? got : "");
  }
}

// =============================================================================
// keyId
// =============================================================================
{
  const pk = "0xd75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f70751" as Hex;
  ok(keyId(pk) === keccak256(pk), "keyId is keccak256 of the pubkey exactly as encoded");
}

// =============================================================================
// verify(): wrong domain / wrong key / wrong alg / malformed key all fail.
// =============================================================================
{
  const sk = ed.utils.randomSecretKey();
  const pk = toHex(await ed.getPublicKeyAsync(sk));
  const objectHash = h("wrong-domain-object");
  const sig = await sign("ed25519", "revoke", objectHash, toHex(sk));

  ok(await verify("ed25519", "revoke", objectHash, sig, pk), "sanity: the honest signature verifies");
  ok(!(await verify("ed25519", "claim", objectHash, sig, pk)), "a signature over one domain fails under another domain");

  const sk2 = ed.utils.randomSecretKey();
  const pk2 = toHex(await ed.getPublicKeyAsync(sk2));
  ok(!(await verify("ed25519", "revoke", objectHash, sig, pk2)), "a signature fails against the wrong public key");

  ok(!(await verify("p256", "revoke", objectHash, sig, pk)), "an ed25519 signature fails when verified as p256");

  ok(!(await verify("ed25519", "revoke", objectHash, sig, "0xdead" as Hex)), "a malformed (too-short) pubkey fails, not throws");
  ok(!(await verify("ed25519", "revoke", objectHash, "0xdead" as Hex, pk)), "a malformed (too-short) signature fails, not throws");
  ok(!(await verify("p256", "revoke", objectHash, sig, "0xdead" as Hex)), "a malformed p256 pubkey fails, not throws");
}

// =============================================================================
// Consent records: unlinkability, nonce validation, cross-episode signatures.
// =============================================================================
{
  const sk = ed.utils.randomSecretKey();
  const pubkey = toHex(await ed.getPublicKeyAsync(sk));
  const base = { holder: "contributor" as const, pubkey, alg: "ed25519" as const,
                 scope_bits: 0b1011, terms_hash: h("terms-v1"), granted_at: 1756900000 };

  const recordA = newConsentRecord(base);
  const recordB = newConsentRecord(base);
  ok(recordA.nonce !== recordB.nonce, "two records for the same holder draw different nonces");

  const keyA = consentKey(recordHash(recordA));
  const keyB = consentKey(recordHash(recordB));
  ok(keyA !== keyB, "two records for the same holder yield different consentKeys (unlinkability)");

  ok(consentKey(recordHash(recordA)).startsWith("0x") && consentKey(recordHash(recordA)).length === 66,
     "consentKey is a 32-byte hash");

  // Deriving consentKey without the 0x02 domain byte would silently collide
  // with revocationValue-shaped inputs elsewhere (PLAN Sec27 trap #8).
  ok(consentKey(recordHash(recordA)) !== keccak256(recordHash(recordA)),
     "consentKey is not just keccak256(recordHash) -- the 0x02 prefix matters");

  // consentCommitment re-salts per episode.
  const salt1 = h("salt-1");
  const salt2 = h("salt-2");
  ok(consentCommitment(recordHash(recordA), salt1) !== consentCommitment(recordHash(recordA), salt2),
     "consentCommitment differs when the salt differs, for the same record");

  ok(revocationValue(recordHash(recordA)) !== revocationValue(recordHash(recordB)),
     "revocationValue differs across two different records");

  // A nonce that isn't exactly 16 bytes must be rejected by recordHash.
  const shortNonce: ConsentRecord = { ...recordA, nonce: "0x" as Hex };
  let threwShort = false;
  try { recordHash(shortNonce); } catch { threwShort = true; }
  ok(threwShort, "a zero-length nonce is rejected");

  const longNonce: ConsentRecord = { ...recordA, nonce: `0x${"00".repeat(17)}` as Hex };
  let threwLong = false;
  try { recordHash(longNonce); } catch { threwLong = true; }
  ok(threwLong, "a 17-byte nonce is rejected");

  // A signature made for episode A's revocation must not verify for episode B --
  // they have different consentKeys even though the same key signs both.
  const sigA = await sign("ed25519", "revoke", keyA, toHex(sk));
  ok(await verify("ed25519", "revoke", keyA, sigA, pubkey), "the signature verifies for its own episode's consentKey");
  ok(!(await verify("ed25519", "revoke", keyB, sigA, pubkey)),
     "a signature for episode A's consentKey fails when checked against episode B's");
}

console.log(fails === 0 ? "\nconsent/sign: all checks passed\n" : `\n${fails} check(s) failed\n`);
process.exit(fails ? 1 : 0);
