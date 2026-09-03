# Architecture decisions — authoritative

Decisions coding agents must not change without a FRONTIER-tier ADR
amendment. `PLAN.md §4` lists the same ids in one line each; this file is
the reasoning. Numbering continues from PLAN v2.0 (D-1…D-16).

Format: Decision · Why · Alternatives · Why rejected · Invariant · Revisit if.

---

**D-1 The chain anchors the log; it is never the log.**
Why: cost, privacy, erasure; a log of hashes is verifiable without the chain
holding data. Alternatives: leaves on chain; a data-availability layer.
Rejected: cost and the impossibility of erasure. Invariant: I-12.
Revisit if: a relying party requires on-chain data availability.

**D-2 / D-23 No chain-specific value in any leaf or manifest; anchors are
identified by `(root, size)`.**
Why: the same log is anchored on several chains; proofs must survive any
chain's disappearance. Alternatives: chain id in leaf; primary-index
references. Rejected: lock-in; indices differ per chain. Invariant: I-7.
Revisit if: never for leaves; locators may add chains freely.

**D-3 A corpus is its own Merkle tree over selected episode leaf hashes,
described by a CorpusManifest whose leaf (0x03) is logged; `sealCorpus`
proves that leaf's inclusion.**
Why: v1 made corpus root == log root, so a corpus was the entire log prefix.
Alternatives: on-chain episode lists; per-task subtrees in the log.
Rejected: cost; the log must stay a single ordered sequence. Invariant:
`corpusRoot` is over leaf hashes without a 0x00 prefix at level 0, so it can
never equal a log root over the same leaves (I-8). Revisit if: never.

**D-4 / D-18 `payloadHash` is a CT root over file leaves; episodes commit to
container files *as delivered* plus a `range`; THENAR never slices or
re-encodes.**
Why: reproducible by anyone with the files; provenance stays over the
supplier's bytes; no ffmpeg/parquet writing in the critical path.
Alternatives: per-episode slicing (v2.0). Rejected: bytes would be
THENAR-produced; large task; lossy video boundaries. Invariant: I-4.
Revisit if: buyers require per-episode delivery — then the *supplier*
slices at source and commits per-episode files (`layout: per_episode`).

**D-5 / D-28 RFC 8785 (JCS) for JSON; arrays that are sets are sorted by
the schema (files by path bytes, channels by name, episodes by log index).**
Why: JCS does not sort arrays; unsorted arrays would make equal content hash
differently. Alternatives: hash a sorted projection. Rejected: two
serialisations invite drift. Invariant: I-5; validation rejects unsorted.

**D-6 / D-26 keccak256 everywhere; Ed25519 for software keys, ECDSA P-256
for hardware keys (Android Keystore, App Attest, TPM), secp256k1 only for
EVM accounts.**
Why: EVM cost; hardware key support is P-256 in practice. Alternatives:
Ed25519 only (v2.0). Rejected: excludes every mainstream secure element.
Invariant: §10.6 encodings. Revisit if: never for existing keys.

**D-7 / D-19 Consent is per episode (fresh nonce), revocation requires a
signature by the record's key over a domain-separated message, and the
record names its holder (contributor or organisation).**
Why: a reused record makes `consentKey` a stable identifier exposed in
reports/proofs; unauthenticated revocation proves only THENAR's action.
Alternatives: per-contributor key with linkable consentKey; unsigned
revocation via the supplier. Rejected: privacy; attribution. Invariant:
I-3, I-6. Revisit if: a jurisdiction requires a single erasure act to cover
all episodes — then the SDK batches signatures; the protocol is unchanged.

**D-8 Verification results are signed leaves (0x04), never mutable fields.**
Why: attribution and history. Invariant: I-13.

**D-9 Avalanche C-Chain primary, Ethereum/Sepolia mirror, identical
bytecode; `LicenceRegistry` on the primary only.**
Why: USDC-native settlement and cheap finality; mirrors give resilience and
answer the "chain choice" objection. Alternatives: single chain; own L1.
Rejected: fragility; operational burden with no volume. Revisit if: a
consortium wants to run validators (Avalanche L1), or USDC settlement never
occurs on chain in year 1 (then anchoring only).

**D-10 Anchorer = relayer EOA that can only call `anchor()`, controlled by a
2-of-3 Safe that can replace it.**
Why: one hot key controlled the head. Alternatives: Safe signs each anchor.
Rejected: hourly multisig signing is impractical. Invariant: I-2.

**D-11 / D-22 Settlement is ERC-20 only; payees are supplier and protocol;
no curator, no cap table, no `TaskRegistry` in the v2 deployment.**
Why: the foundry/curator model is shelved; contributors are paid by
suppliers off-chain; every extra payee is surface without a customer.
Alternatives: keep curator share "just in case". Rejected: unused code in a
money contract. Revisit if: a curator marketplace returns.

**D-12 / D-24 SQLite (append-only triggers, cached tree nodes) through Phase
C; Postgres deferred.**
Why: the wedge handles thousands of episodes; SQLite with WAL and triggers
gives the same immutability guarantee with no infrastructure. Alternatives:
Postgres now. Rejected: infrastructure ahead of need. Invariant: I-2 via
triggers. Revisit if: multi-process writes or >10⁶ leaves.

**D-13 The simulation foundry is shelved; `TaskSpec`/sampler remain as
optional `sim` metadata.** Why: not on the critical path; simulated data has
no buyer. Revisit if: a simulation-provenance customer appears.

**D-14 / D-15 One registry (`LicenceRegistry`), one stateless verifier;
`GraspLog` does not parse leaves.** Why: one place to add a leaf version.

**D-16 No token, staking, slashing, ZK or TEE pipeline.** Why: no claim in
§1 needs them. Revisit if: third-party verifiers need economic security.

**D-17 Anchor rule: `size` non-decreasing. If `size` grows, `root` must
change. If `size` is equal, `root` must equal the previous root and
`revocationRoot` must change.**
Why: revocations must be anchorable without new leaves; v1 could not, and
the e2e script forged an incoherent anchor to work around it. Alternatives:
append a marker leaf per revocation batch. Rejected: pollutes the log with
non-episodes. Invariant: I-2; consistency proofs for equal sizes are empty.

**D-20 Key validity is evaluated at the leaf's first anchor timestamp on the
primary chain, never at a self-declared time.**
Why: `captured_at`/`issued_at` are claims; a compromised key could
back-date. Invariant: level engine and verifiers use anchor time.

**D-21 Claim levels are badges over an L0 base, not a cumulative ladder
(only L2 ⇒ L1); wording is fixed; L3 is "Checked by {operator}".**
Why: the wedge ingests unsigned public datasets and must still reach L3;
"verified/independent" over-claims. Invariant: I-1 wording test.

**D-25 L2 (hardware attestation) is Phase D and optional; supported devices
are listed explicitly; Quest is unverified.**
Why: no buyer has asked; Quest/Jetson support is unproven. Revisit if: a
supplier on supported hardware asks.

**D-27 Terms are keyed by `termsHash = keccak256(document bytes)`; there is
no numeric terms id.** Why: leaves and receipts already carry the hash; two
identifiers invite mismatch. Invariant: I-8.

**D-29 W1 reads chain state directly with a short cache; no indexer.** Why:
tens of rows. Revisit if: query volume or multi-chain receipts justify it.

---

## Added by review B (2026-09-03) — the live product and the protocol

**D-30 Source is an axis orthogonal to evidence levels, and is always
"declared" unless attested.**
Decision: `CaptureManifest.source ∈ { sim, teleop_sim, teleop_real,
autonomous_real, mixed }`. Every surface renders `source` with the word
"declared" unless the *attested-physical* condition holds: L2 attestation of
the robot controller's key AND `sim_signature.v1 = pass` (and, when video
exists, `sensor_consistency.v1 = pass`). `sim`/`teleop_sim` can never render
as physical. CorpusManifest carries `sources[]`; a corpus mixing declared
physical and sim episodes is `mixed`.
Why: evidence levels answer "are these bytes what the signer says?"; they
never answer "did a robot do this?". Conflating them is the single most
damaging over-claim available. Alternatives: fold source into levels
(rejected — a sim episode can legitimately be L1+L3); trust the declared
value (rejected — it is the fraud vector). Invariant: I-16. Reconsider if:
never for the axis; the attested condition may gain checks by ADR.

**D-31 The browser arm survives as `/lab/arm`, a reference capture source of
kind `sim`, capped at L1 + L3, signed by a WebAuthn passkey, paying nobody.**
Why: it is the only capture loop THENAR controls end to end (demo of
capture→settlement) and a deterministic fixture generator for the verifier.
Alternatives: delete (loses the demo and fixtures); keep as a bounty
marketplace (zero usage after a full loop shipped; physics-free trajectories
train nothing); add MuJoCo physics (a programme with no buyer). Invariant:
lab episodes are `source: "sim"`, `holder: "organisation"`, never
protocol-paid. Reconsider if: a customer asks for simulation-provenance
tooling.

**D-32 The live scorer (placement/smoothness/time) becomes a check, not a
payment rule.**
Decision: `task_compliance.v1` (check id 0x0007), FD-5 gated, deferred.
Why: task compliance is the second thing buyers filter on; as a payment rule
it invites gaming, as a signed claim with recorded thresholds it is evidence.
Alternatives: keep as payout scaling (rejected — no protocol payouts).
Invariant: I-15 applies. Reconsider if: E2 buyers ask for success labels.

**D-33 The live site's marketplace mechanics are retired, not ported.**
Retired: escrow bounties, referrals, prize pools, work-weighted treasury vote,
soulbound certificates, contribution counter, confidential payouts,
Warp-signed receipts, the local L1, time-boxed "access not rights". Kept as
ideas already in v2: corpus manifest (as a logged leaf), licence receipt (as
`LicenceRegistry`), passkey signing (as P-256 keys, D-26). The Axon contract
addresses are archived on `/company` as history, like Monad.
Why: none of the retired pieces serves a relying party; each is a bounty
feature. Alternatives: keep both products (two half-companies). Invariant:
D-16, D-22 stand. Reconsider if: a customer asks to *pay contributors through*
the registry — then a supplier-side payout list, not a marketplace.

**D-34 Phase D (SDK, attestation, devices, lab arm recorder) starts only after
E2 yields three paid Provenance Reports.**
Why: every Phase D task is supply-side infrastructure; the thesis is unproven
until a buyer pays. Alternatives: build the SDK in parallel (rejected —
capital and attention). Invariant: `TASKS/README.md` gate. Reconsider if: a
supplier offers to pay for the SDK before E2 completes.

**D-35 "Trusted machine experience" is the category name; "data foundry"
and "CT for machine experience" are retired as taglines.**
Why: the first sells a problem we do not solve; the second names a mechanism,
not a value. Product tagline stays "Provenance and rights for physical-AI
data." Reconsider if: customer language differs after E2.

**D-36 Deploying this repository's site to thenar.io replaces the Axon site
and is a founder decision taken after T-033 runs, not before.**
Why: outward-facing; the live site is the only public artefact today.
Invariant: no agent repoints DNS or hosting.
