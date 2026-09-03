/**
 * T-030 — adversarial suite, protocol (TS) level (TASK-030.md "Attacks"
 * 1-7, 9-10, 17). Each attack is a named test that must be REFUSED: either
 * the library throws/returns false, or a hand-rolled replay of the
 * verification the chain performs (mirroring `run.ts`'s `replayInclusion`/
 * `replayConsistency`) fails to reproduce the honest root. This is the
 * regression guard for I-10: `MerkleLog`, `SparseMerkle`, the leaf codecs,
 * canonical JSON and signatures must stay refused against every attack
 * here across any future refactor.
 */
import { keccak256, toHex, type Hex } from "viem";
import * as ed from "@noble/ed25519";
import * as log from "../src/log";
import { SparseTree, computeRoot as smtComputeRoot, ZERO } from "../src/sparse";
import { hashObjectExcluding } from "../src/canonical";
import { sign, verify, message } from "../src/sign";
import { CaptureManifestSchema } from "../src/schemas";
import manifestFixture from "./fixtures/manifest.json" with { type: "json" };

let fails = 0;
const ok = (cond: boolean, msg: string, extra = "") => {
  if (!cond) fails++;
  console.log(`${cond ? "  ok  " : " FAIL "} ${msg}${extra ? ` — ${extra}` : ""}`);
};

const h = (s: string): Hex => keccak256(toHex(s));

// ============================================================ log helpers

/** Replay `MerkleLog.verifyInclusion`'s walk exactly, but *does not* derive
 * side from the index — instead it takes an explicit `sides[]` (true =
 * proof sibling goes on the left) supplied by the caller, so a test can
 * show that only the honest, index-derived sides reconstruct the root. */
function replayWithSides(leaf: Hex, proof: Hex[], sides: boolean[]): Hex {
  if (proof.length !== sides.length) throw new Error("proof/sides length mismatch");
  let node = leaf;
  for (let k = 0; k < proof.length; k++) {
    node = sides[k] ? log.hashNode(proof[k], node) : log.hashNode(node, proof[k]);
  }
  return node;
}

/** The honest walk (mirrors `run.ts`): side derives from `index`, not from the proof. */
function replayInclusion(leaf: Hex, proof: Hex[], index: number, size: number): Hex {
  let node = leaf, i = index, n = size, p = 0;
  while (n > 1) {
    if (i % 2 === 1) node = log.hashNode(proof[p++], node);
    else if (i + 1 < n) node = log.hashNode(node, proof[p++]);
    i = Math.floor(i / 2);
    n = Math.ceil(n / 2);
  }
  if (p !== proof.length) throw new Error("proof length mismatch");
  return node;
}

function replayConsistency(m: number, first: Hex, n: number, second: Hex, proof: Hex[]): boolean {
  if (m === n) return proof.length === 0 && first === second;
  let node = m - 1, last = n - 1, p = 0;
  while (node % 2 === 1) { node = Math.floor(node / 2); last = Math.floor(last / 2); }
  let fr: Hex, sr: Hex;
  if (node > 0) { fr = proof[p]; sr = proof[p]; p++; } else { fr = first; sr = first; }
  while (node > 0) {
    if (node % 2 === 1) { const s = proof[p++]; fr = log.hashNode(s, fr); sr = log.hashNode(s, sr); }
    else if (node < last) { sr = log.hashNode(sr, proof[p++]); }
    node = Math.floor(node / 2); last = Math.floor(last / 2);
  }
  while (last > 0) { sr = log.hashNode(sr, proof[p++]); last = Math.floor(last / 2); }
  return p === proof.length && fr === first && sr === second;
}

const leaves11: Hex[] = Array.from({ length: 11 }, (_, i) => h(`adv-leaf-${i}`));
const root11 = log.root(leaves11);

// ========================================================== attack 1 =====
// Inclusion proof with a sibling moved to the other side (must fail; side
// derives from index, never from the proof).
{
  const index = 4;
  const proof = log.inclusionProof(leaves11, index);
  const honest = replayInclusion(leaves11[index], proof, index, leaves11.length);
  ok(honest === root11, "attack 1 sanity: the honest walk reproduces the root");

  // The honest side sequence, per the same rule `replayInclusion` follows.
  let i = index, n = leaves11.length;
  const honestSides: boolean[] = [];
  while (n > 1) {
    if (i % 2 === 1) honestSides.push(true);
    else if (i + 1 < n) honestSides.push(false);
    i = Math.floor(i / 2);
    n = Math.ceil(n / 2);
  }
  ok(replayWithSides(leaves11[index], proof, honestSides) === root11, "attack 1 sanity: explicit honest sides also reproduce the root");

  // Flip exactly one sibling to the other side — the attack.
  const flipped = [...honestSides];
  flipped[0] = !flipped[0];
  const forged = replayWithSides(leaves11[index], proof, flipped);
  ok(forged !== root11, "attack 1: a sibling moved to the other side does not reproduce the root");
}

// ========================================================== attack 2 =====
// Proof padded with one extra sibling / truncated by one.
{
  const index = 4;
  const proof = log.inclusionProof(leaves11, index);
  ok(proof.length > 0, "attack 2 sanity: this leaf's proof is non-empty");

  const padded = [...proof, h("extra-sibling")];
  let paddedThrew = false;
  try { replayInclusion(leaves11[index], padded, index, leaves11.length); } catch { paddedThrew = true; }
  ok(paddedThrew, "attack 2: a proof padded with one extra sibling is refused (length mismatch)");

  const truncated = proof.slice(0, -1);
  let truncatedThrew = false;
  let truncatedRoot: Hex | null = null;
  try { truncatedRoot = replayInclusion(leaves11[index], truncated, index, leaves11.length); } catch { truncatedThrew = true; }
  ok(truncatedThrew || truncatedRoot !== root11, "attack 2: a proof truncated by one is refused (length mismatch or wrong root)");
}

// ========================================================== attack 3 =====
// Leaf index >= size; size 0.
{
  let threwOver = false;
  try { log.inclusionProof(leaves11, leaves11.length); } catch { threwOver = true; }
  ok(threwOver, "attack 3: inclusionProof at index === size is refused");

  let threwWayOver = false;
  try { log.inclusionProof(leaves11, leaves11.length + 100); } catch { threwWayOver = true; }
  ok(threwWayOver, "attack 3: inclusionProof at index >> size is refused");

  let threwEmpty = false;
  try { log.inclusionProof([], 0); } catch { threwEmpty = true; }
  ok(threwEmpty, "attack 3: inclusionProof against a size-0 log is refused");

  let threwNegative = false;
  try { log.inclusionProof(leaves11, -1); } catch { threwNegative = true; }
  ok(threwNegative, "attack 3: a negative index is refused");
}

// ========================================================== attack 4 =====
// Consistency proof from a *different* log with the same size.
{
  const n = 11;
  const leavesA = leaves11; // "log A"
  const leavesB: Hex[] = Array.from({ length: n }, (_, i) => h(`log-b-leaf-${i}`)); // "log B", same size
  ok(log.root(leavesA) !== log.root(leavesB), "attack 4 sanity: two different logs of the same size have different roots");

  const m = 7;
  const proofFromA = log.consistencyProof(leavesA, m, n);
  const rootAatM = log.root(leavesA.slice(0, m));
  const rootAatN = log.root(leavesA);
  const rootBatN = log.root(leavesB);

  ok(replayConsistency(m, rootAatM, n, rootAatN, proofFromA), "attack 4 sanity: A's own consistency proof verifies against A's own roots");
  ok(!replayConsistency(m, rootAatM, n, rootBatN, proofFromA),
     "attack 4: A's consistency proof does not verify against log B's root of the same size");
}

// ========================================================== attack 5 =====
// Interior node presented as a leaf (0x01-prefixed value passed as a leaf).
{
  const index = 4;
  const proof = log.inclusionProof(leaves11, index);
  // An interior node one level up from `index` — computed with the 0x01
  // domain prefix (`log.hashNode`), never the 0x00 leaf domain.
  const interiorNode = log.hashNode(leaves11[8], leaves11[9]);

  ok(!leaves11.includes(interiorNode), "attack 5 sanity: the interior node's hash is not equal to any genuine leaf hash (domain separation)");

  // Substitute it for the real leaf at `index` and try to reconstruct the
  // root with that leaf's own proof — must not verify.
  const forged = replayInclusion(interiorNode, proof, index, leaves11.length);
  ok(forged !== root11, "attack 5: an interior node presented as a leaf does not reproduce the root");
}

// ========================================================== attack 6 =====
// SMT non-membership proof for a key that IS present (must fail); a real
// leaf may never be zero (the TS-level guard behind Solidity's ZeroLeafValue).
{
  const tree = new SparseTree();
  const presentKey = h("attack6-present-key");
  const presentValue = h("attack6-present-value");
  tree.set(presentKey, presentValue);
  const root = tree.root();

  const { bitmap, siblings } = tree.proof(presentKey);
  // Claim non-membership (value = ZERO) for a key that is in fact present.
  ok(smtComputeRoot(presentKey, ZERO, bitmap, siblings) !== root,
     "attack 6: a non-membership proof for a present key does not reproduce the root");
  // The honest membership proof (value = presentValue) does reproduce it.
  ok(smtComputeRoot(presentKey, presentValue, bitmap, siblings) === root,
     "attack 6 sanity: the honest membership proof does reproduce the root");

  // A real leaf may never be zero — mirrors Solidity's `ZeroLeafValue`.
  let threwOnZero = false;
  try { tree.set(h("attack6-other-key"), ZERO); } catch { threwOnZero = true; }
  ok(threwOnZero, "attack 6: writing a zero-value leaf is refused");
}

// ========================================================== attack 7 =====
// Onset proof where the key is also present at index-1 (not a first
// sighting: the non-membership-at-index-1 half of the onset proof fails).
{
  const key = h("attack7-onset-key");
  const value = h("attack7-onset-value");

  // "anchor index-1": the key is ALREADY revoked here.
  const treeBefore = new SparseTree();
  treeBefore.set(key, value);
  const rootBefore = treeBefore.root();

  // "anchor index": still revoked (nothing changed — an attacker claiming
  // this is the first sighting when it plainly is not).
  const treeAt = new SparseTree();
  treeAt.set(key, value);
  const rootAt = treeAt.root();

  // Half 1 of `revocationOnset`: membership at `index` — this alone succeeds.
  const proofAt = treeAt.proof(key);
  ok(smtComputeRoot(key, value, proofAt.bitmap, proofAt.siblings) === rootAt,
     "attack 7 sanity: membership at the claimed onset anchor verifies");

  // Half 2: non-membership at `index - 1` — must hold for a genuine onset,
  // and here it does NOT, because the key was already present.
  const proofBefore = treeBefore.proof(key);
  ok(smtComputeRoot(key, ZERO, proofBefore.bitmap, proofBefore.siblings) !== rootBefore,
     "attack 7: non-membership at index-1 fails when the key was already present — not a first sighting");
}

// ========================================================== attack 9 =====
// Revocation signed by a different key; signed under the manifest domain;
// replayed for a different consent key.
{
  const skA = ed.utils.randomSecretKey();
  const pkA = toHex(await ed.getPublicKeyAsync(skA));
  const skB = ed.utils.randomSecretKey();
  const pkB = toHex(await ed.getPublicKeyAsync(skB));

  const consentKeyA = h("attack9-consent-key-a");
  const consentKeyB = h("attack9-consent-key-b");

  // (a) signature from a different key than the one named in the record.
  const sigFromB = await sign("ed25519", "revoke", consentKeyA, toHex(skB));
  ok(!(await verify("ed25519", "revoke", consentKeyA, sigFromB, pkA)),
     "attack 9a: a revocation signed by a different key than the record's own pubkey is refused");
  ok(await verify("ed25519", "revoke", consentKeyA, sigFromB, pkB),
     "attack 9a sanity: that same signature does verify against the key that actually signed it");

  // (b) the manifest domain used where the revoke domain is required.
  const sigManifestDomain = await sign("ed25519", "manifest", consentKeyA, toHex(skA));
  ok(!(await verify("ed25519", "revoke", consentKeyA, sigManifestDomain, pkA)),
     "attack 9b: a signature made under the manifest domain is refused when revoke is required");
  ok(toHex(message("manifest", consentKeyA)) !== toHex(message("revoke", consentKeyA)),
     "attack 9b sanity: the manifest and revoke domain messages actually differ");

  // (c) a genuine revoke signature for consentKeyA replayed against consentKeyB.
  const sigForA = await sign("ed25519", "revoke", consentKeyA, toHex(skA));
  ok(await verify("ed25519", "revoke", consentKeyA, sigForA, pkA), "attack 9c sanity: the honest signature verifies for its own key");
  ok(!(await verify("ed25519", "revoke", consentKeyB, sigForA, pkA)),
     "attack 9c: a revoke signature for one consent key is refused when replayed for a different one");
}

// ========================================================= attack 10 =====
// Manifest with `signature` mutated after signing.
{
  const sk = ed.utils.randomSecretKey();
  const pk = toHex(await ed.getPublicKeyAsync(sk));
  const manifest = { ...manifestFixture, signature: null } as unknown as Record<string, unknown>;
  const mHash = hashObjectExcluding(manifest as any, ["signature"]);
  const sig = await sign("ed25519", "manifest", mHash, toHex(sk));
  ok(await verify("ed25519", "manifest", mHash, sig, pk), "attack 10 sanity: the honest manifest signature verifies");

  // Flip the last hex nibble of the signature — a signature mutated after signing.
  const mutated = (sig.slice(0, -1) + (sig.endsWith("0") ? "1" : "0")) as Hex;
  ok(!(await verify("ed25519", "manifest", mHash, mutated, pk)),
     "attack 10: a signature mutated after signing is refused");
}

// ========================================================= attack 17 =====
// Chain-id injection: a manifest containing `chain_id` must be rejected by
// schema (I-7) — a `.strict()` zod object refuses an unknown key.
{
  const injected = { ...manifestFixture, chain_id: 43114 };
  const parsed = CaptureManifestSchema.safeParse(injected);
  ok(!parsed.success, "attack 17: a manifest carrying chain_id is rejected by the closed schema");
  if (!parsed.success) {
    const hitsChainId = parsed.error.issues.some((iss) => iss.path.includes("chain_id") || /chain_id|unrecognized/i.test(iss.message));
    ok(hitsChainId, "attack 17: the rejection names the unrecognized chain_id key", JSON.stringify(parsed.error.issues));
  }

  // Sanity: the fixture itself, unmodified, is valid — so the rejection
  // above is specifically about chain_id, not some other drift.
  const clean = CaptureManifestSchema.safeParse(manifestFixture);
  ok(clean.success, "attack 17 sanity: the unmodified fixture manifest parses cleanly", clean.success ? "" : JSON.stringify((clean as any).error?.issues));
}

console.log(fails === 0 ? "\nadversarial (protocol): all 15 checks across attacks 1-7,9-10,17 passed\n" : `\n${fails} check(s) failed\n`);
process.exit(fails ? 1 : 0);
