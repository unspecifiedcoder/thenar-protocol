# Review Pack — THENAR/GRASP v2.1

External review material for the smart contracts and their integration with the off-chain log service.

## Contract List

### GraspLog

Append-only Certificate Transparency-style Merkle tree anchor. Records the root, size, and sparse-tree revocation root of the log; enforces the D-17 anchor rule (size non-decreasing; equal-size anchors must have different revocation roots; growing anchors must have different roots); emits an `Anchored` event for every call. No parsing of leaves; no state beyond anchors and the anchorer address. Transfer of anchorer privilege is two-step. Entry point for verifying leaf inclusion, consistency, consent liveness, and revocation onset; all proofs are verified against publicly known anchors and hashes.

**ABI:** `packages/contracts/out/GraspLog.sol/GraspLog.json`

### LeafVerifier

Dispatcher and decoder for leaf versions 0x01–0x04. Hashes preimages by version; rejects wrong-length preimages. Provides read-only accessors for episode facts (taskId, worldSeed, success, qualityScore), corpus facts (manifestHash, corpusRoot, termsHash, episodeCount, sealedAt), and claim facts (subjectLeaf, verifierKeyId, checkId, result, level, issuedAt). Dispatches to the log for inclusion verification. No state; pure functions for hashing and fact extraction.

**ABI:** `packages/contracts/out/LeafVerifier.sol/LeafVerifier.json`

### LicenceRegistry

Single-chain registry for terms, sealed corpora, and payment receipts. Publishes and retires term hashes (append-only); seals corpora by reproving their 0x03 leaf inclusion in the log and cross-checking facts; licenses corpora by accepting ERC-20 payment (via `transferFrom` with tolerance for tokens that return false, omit return data, or revert) and writing a receipt before any payout. Receipts name `(termsHash, corpusManifestHash, corpusRoot)` so they verify without trusting later state. Payees are the supplier and the protocol (2.5%, configurable via `PROTOCOL_BPS`). Failed payouts are credited (tracked per payee and token) and can be retried via `withdraw`. No native-token path; no upgrades; no proxies.

**ABI:** `packages/contracts/out/LicenceRegistry.sol/LicenceRegistry.json`

## Trust Model (from PLAN §6)

| Party | Trusted for | Not trusted for | Mitigation |
| --- | --- | --- | --- |
| THENAR (anchorer) | Not forking the head (chain-enforced); anchoring on time | Not omitting leaves; not fabricating leaves | Signed append receipts held by suppliers; `/anchors/audit`; mirrors; Safe-controlled relayer |
| THENAR (verifier) | Running the checks it names | Being right | Thresholds recorded per claim; claims signed and disputable; third-party verifiers later |
| Supplier | Its signature (L1) | Physical truth of content; `captured_at`; `source` | L3 checks; wording |
| Device manufacturer | Attestation chain (L2) | Anything above the key | Roots pinned; level capped at L2 |
| Contributor / holder | Owning the consent key | — | Revocation signed |
| Chain | Ordering, timestamps, receipt immutability | RPC availability | Mirrors; user-supplied RPC on `/verify` |
| Buyer | Paying | — | Receipt-gated delivery |

## Threat Model (from PLAN §7)

| Threat | Control |
| --- | --- |
| Head rewrite (anchorer key compromise) | D-10; D-17 rule; mirrors detect divergence |
| Omission / censorship | Signed append receipts (evidence of accepted-not-anchored); `/anchors/audit`; public SLA |
| Fabricated episode | L1 attributes; L3 dedup/plausibility; L4 later |
| Jittered replay / duplicate | `dedup.v1` (heuristic, recorded thresholds) |
| Simulation passed as real | `sim_signature.v1` indicative; manifest `source` is a claim |
| Forged revocation | Signature over `revoke` domain by the record's key |
| Withheld revocation | Holder keeps signed revocation + service receipt; onset proof shows first appearance |
| Corpus substitution | Receipt names `corpusRoot`; each episode proves inclusion in corpus tree and log |
| Terms swap | Terms by hash, append-only, retire-only |
| Identity leak / linkability | Per-episode consent records; re-salted commitments; no org id on chain |
| Proof forgery | Sibling side from index; strict lengths; 0x00/0x01 domain bytes |
| Back-dated keys/claims | D-20: validity at first-anchor time |
| RPC spoofing on `/verify` | Chain + RPC shown; user-supplied RPC; mirrors |
| Key extraction on device | L1 only unless attestation proves hardware residency |

## Known Limitations (from PLAN §22)

These limitations are verbatim in every provenance report:

- The operator (THENAR) can decline to log or anchor a record; append receipts and public audit make this detectable, not impossible.
- Checks are heuristics with recorded thresholds; they can be evaded and can err; they are evidence, not proof.
- A signature proves which key signed, not what a sensor measured; `captured_at`, `source` and `embodiment` are claims by the signer.
- Consent onset is recorded; what a buyer may do after onset is governed by the terms document, not by this protocol.
- Anchors depend on the availability of at least one chain carrying the log; the same log is anchored on more than one.

## Test Commands

### Unit Tests

```bash
cd packages/contracts
forge test -vv
```

Runs all standard tests including leaf encoding, anchor rules (D-17 matrix), corpus sealing, licensing (split, credit, withdrawal), and ERC-20 shape tolerance.

### Invariant Tests

```bash
cd packages/contracts
forge test --match-path 'test/invariant/*' -vv
```

Runs invariant tests:
- **Log invariants:** anchors form a monotonic, consistent chain; sizes never shrink; equal-size anchors differ only in revocation root; `prevRoot` chains correctly.
- **Registry invariants:** every receipt references a valid, sealed corpus; receipt fields match the corpus; credited amounts track correctly.

Default: 256 calls per test, depth 32. To raise locally to 10k:
```bash
forge test --match-path 'test/invariant/*' --invariant-runs 10000 --invariant-depth 100
```

### Gas Snapshot

```bash
cd packages/contracts
forge snapshot
```

Generates `.gas-snapshot`. Check against checked-in snapshot:
```bash
forge snapshot --check
```

### Static Analysis (Slither)

```bash
cd packages/contracts
pip install slither-analyzer
slither . --fail-on high
```

Or via CI: `crytic/slither-action` with `fail-on: high`.

## Deployment Addresses

Filled in after T-009 deploys to Fuji and Sepolia.

| Chain | Contract | Address |
| --- | --- | --- |
| Avalanche Fuji | GraspLog | `0x…` |
| Avalanche Fuji | LeafVerifier | `0x…` |
| Avalanche Fuji | LicenceRegistry | `0x…` |
| Ethereum Sepolia | GraspLog | `0x…` |
| Ethereum Sepolia | LeafVerifier | `0x…` |

## Execution

External reviewers should:
1. Clone the repository and `cd packages/contracts`.
2. Install Foundry: `curl -L https://foundry.paradigm.xyz | bash; foundryup`.
3. Run `forge install foundry-rs/forge-std --no-git`.
4. Run `forge test -vv` (unit tests).
5. Run `forge test --match-path 'test/invariant/*' -vv` (invariant tests).
6. Run `forge snapshot --check` (gas limits).
7. Optionally, install Slither and run static analysis.

All tests must pass. The checked-in gas snapshot must match the current build.

## References

- **PLAN.md §5 (Invariants):** System invariants I-2 (append-only) and I-8 (receipt naming).
- **PLAN.md §6 (Trust Model):** Who is trusted for what.
- **PLAN.md §7 (Threat Model):** Threats and their controls.
- **PLAN.md §11 (Contracts):** Complete contract specs.
- **PLAN.md §22 (Limitations):** Known limitations to report.

## Deployment addresses

| Contract | Address (Avalanche Fuji, 43113) |
| --- | --- |
| `GraspLog` | `0xDF1F8B068229C868be073eA4883186513AC059Fd` |
| `LeafVerifier` | `0x46bb2769C3F55A4Ae0cdA0885F14d191b5D1E307` |
| `LicenceRegistry` | `0xe4565B5Fd752A368DDbF90AB6ca4B321cb4df26D` |
| Mock USDC (testnet only) | `0x23171590c14a13ead6f8407b22a522349efb588b` |
| Deployer / relayer | `0x72db032c0dFB6E7502e16A73fabdab31712dc706` (relayer key; Safe handover pending) |
| Deployed at block | 58151548 |

Mirror (Ethereum Sepolia): pending a funded key.
