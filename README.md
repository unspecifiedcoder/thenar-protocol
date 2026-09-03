# THENAR — Provenance and rights ledger for physical-AI data

**Provenance and rights for physical-AI data.** The neutral log that suppliers
and buyers trust: prove what a dataset is, where it came from, who may train on
it, and whether that is still true — without asking anyone to trust THENAR.

This repository is the core: a Certificate Transparency-style log that commits
episodes to an append-only ledger, lets anyone verify a corpus without trusting
us, lets a contributor withdraw consent provably, and binds payment and licence
terms in one transaction on Avalanche C-Chain (with Ethereum mirror).

| | |
| --- | --- |
| **Site** | https://thenar.io |
| **Primary chain** | Avalanche C-Chain Fuji testnet |
| **Mirror chain** | Ethereum Sepolia |
| **`GraspLog`** | not yet deployed |
| **`LicenceRegistry`** | not yet deployed |
| **Verify a corpus** | `/verify` — reads chains directly, nothing through our servers |

---

## What is on chain, and what is deliberately not

Hashes on chain. Everything else off it.

A buyer needs to verify a slice of capture data without trusting our internal
records, and a contributor needs to withdraw without us being able to pretend
they did not. That is the whole job. Anything beyond it belongs off chain, and
claiming otherwise is the first thing a reviewer kills.

### One leaf per accepted capture

A **154-byte preimage** hashing to a 32-byte leaf: payload hash, sensor manifest
hash, a consent commitment, the terms id, capture and submission timestamps,
duration, scope bits, channel count. **No identity, no payload, no free text.**

The consent commitment is salted with fresh randomness on every submission,
because a stable pseudonymous identifier written on chain is one no erasure
request can ever undo — and that single mistake would break the entire privacy
position. Two captures from the same contributor cannot be linked by anyone
reading the log.

### A monotonic head, not a bag of roots

The log is an append-only Merkle tree in the Certificate Transparency style,
living off chain and anchored with its previous root and its size. Publishing a
pile of unrelated roots would prove nothing about ordering; a monotonic head
with a size is what makes a **consistency proof** possible.

`anchor()` refuses a size that does not grow and a root that does not change, so
the head cannot stutter or be quietly rewound.

### Revocation needs a non-membership proof

Withdrawal is the hard half. A buyer has to prove a capture's consent was **not**
revoked as of a given root, and an inclusion list cannot express absence. So
revocations live in a **sparse Merkle tree** anchored in the same call — one
extra word per anchor. `revocationOnset()` reports the block at which a
withdrawal became publicly knowable, proved by showing it present at one anchor
and absent at the one before.

### Payment and terms in one transaction

The only part where a chain genuinely beats the alternatives. Off chain, the
claim that a buyer paid for a corpus under a specific version of the licence is
our word. On chain it is a transfer and a statement of terms in the same call,
and neither side can revise it afterwards. A purchase is refused unless the
corpus root is one the log actually anchored.

---

## Why the C-Chain, and not our own L1

Because the workload does not have the shape that justifies a chain of its own,
and claiming it does is the first thing a reviewer kills. Batched hourly, our
entire provenance traffic is on the order of tens of transactions a day. A
dedicated L1 would cost orders of magnitude more, but the money is not the
argument: an L1 needs a part-time operator we do not have.

The decisive reason is settlement. USDC is native and deep on the C-Chain; on
our own L1 it would be a bridged representation secured by nodes we run
ourselves, which is a company with no revenue underwriting buyer funds.

`GraspMarket` takes any ERC-20, so USDC is a constructor argument rather than a
rewrite.

## Status

v2 deploys on Avalanche C-Chain (Fuji testnet) with Ethereum (Sepolia) as a mirror.
The contracts are built and tested; deployment is pending. The web reader and
`/verify` page work against live chains once addresses are deployed.

## Live deployment (v2, Avalanche Fuji)

| Contract | Address (Avalanche Fuji, 43113) |
| --- | --- |
| `GraspLog` | `0xde2E34b8A97774807842470b2619dC8BB099EaF1` |
| `LeafVerifier` | `0x44589a2464C4CD29df57CB757fC3e1296c38b565` |
| `LicenceRegistry` | `0x1a89aB71F65E50B36Eae138268Dc8D8f44f23Ccd` |
| Mock USDC (testnet only) | `0x5f344d9dba76f8da0ec0cb0211d077a121175e07` |
| Deployer / relayer | `0x72db032c0dFB6E7502e16A73fabdab31712dc706` (relayer key; Safe handover pending) |
| Deployed at block | 58152901 |

Mirror (Ethereum Sepolia): deferred to the mainnet checklist.

Superseded (first Fuji deployment, block 58151548; its log carries one anchor from a scratch store and is not coherent): `GraspLog 0xDF1F8B068229C868be073eA4883186513AC059Fd`, `LeafVerifier 0x46bb2769C3F55A4Ae0cdA0885F14d191b5D1E307`, `LicenceRegistry 0xe4565B5Fd752A368DDbF90AB6ca4B321cb4df26D`.

## Deployment history

**v1** (archived) was prototyped end-to-end. Addresses and the final state are
recorded in `docs/PLAN-2026-08-status.md` for reference.

**v2** targets Avalanche C-Chain (primary) with Ethereum (Sepolia) as a mirror.
Architecture: RFC 6962 log, sparse Merkle consent tree, identity-free leaves,
stateless verifier. Four products: Provenance Report (W1), Recorder SDK (W2),
Licence Registry, and Consent Service.

---

## Layout

```
apps/web              the site — static, no build step, three.js for the rigs
packages/contracts    Foundry: GraspLog, GraspMarket, and the proof libraries
packages/protocol     the reference implementation the log is actually built with
scripts               end-to-end proof against the live deployment
```

`packages/protocol` is not a helper — it is the log. The Solidity verifies what
this produces, and the test vectors in `packages/contracts/test/Vectors.sol` are
generated from it, so a passing suite means both implementations agree on every
hash.

## Run it

```bash
pnpm install
pnpm test:protocol      # the off-chain library, 13 checks
pnpm vectors            # regenerate Solidity test vectors from it
pnpm test:contracts     # 39 tests incl. two 256-run fuzzes
```

Against the live deployment, with a funded testnet key in `.env.deployer`:

```bash
node --experimental-strip-types scripts/e2e.mjs
```

That builds a batch of captures, anchors it, has the chain confirm one
capture is in the log, extends the log and has the chain confirm nothing was
rewritten, withdraws a consent and reads back the block it became knowable, then
publishes terms and buys a licence. It writes `apps/web/sample-proof.json` so
`/verify` can be exercised with values that actually check out.

## Serving the site

```bash
cd apps/web && python3 -m http.server 8080
```

No build step and no bundler. `/verify` talks to the contract over JSON-RPC directly;
reads need no wallet.

---

## What this does not solve

Anchoring proves a record existed and was not reordered. It does not prove the
record is *true* — that the sensor was calibrated, that the hand was where the
manifest says, or that a capture was not manufactured. That is a hardware and
attestation problem, and it is not fixed by writing a hash to a chain. The Band
validation work is what addresses it, and until that exists this layer should be
read as provenance, not proof of measurement.

The ledger drawn on the landing page reads from the contract. Figures elsewhere
on the site that describe the market are illustrative of the model and say so.
