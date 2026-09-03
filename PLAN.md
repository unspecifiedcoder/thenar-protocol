# PLAN.md — THENAR / GRASP v2.1

**Status:** normative. This file is the source of truth for implementation.
An implementation agent reads the sections its task points at and executes
without re-deriving the architecture. Where this file and the code disagree,
the code is wrong unless a task says otherwise. Where this file is wrong or
silent, the agent **stops** (§26) and files a conflict in
`TASKS/CONFLICTS.md` — it does not patch the plan.

**v2.1 (2026-09-03)** supersedes v2.0 after the gate review in
`docs/REVIEW-2026-09-03.md`. Decisions and their reasoning live in
`docs/ARCHITECTURE-DECISIONS.md` (ADR ids `D-n`). Strategy lives in
`docs/THESIS.md`. Tasks live in `TASKS/`. The v1 plan is archived at
`docs/PLAN-2026-08-status.md`.

**Working-tree rule for agents:** this checkout is shared. Never run
`git stash`, `git checkout -- <path>`, `git reset`, `git clean`, or anything
else that rewrites files you did not author in your task. Use `git mv` /
`git rm` only for moves and deletes your task names.

---

## 0. Mission

Be the neutral provenance and rights ledger for physical-AI training data:
prove what a dataset is, where it came from, who may train on it, and whether
that is still true — without asking anyone to trust THENAR.

## 1. Product thesis and claim levels

- **Customer:** data suppliers who must sell to enterprise counsel; buyers and
  their counsel de-risking a purchase.
- **Wedge product (W1):** the *Provenance Report* — ingest an existing
  LeRobot v3 corpus, commit every episode to a public append-only log, run
  checks, anchor, seal a corpus, deliver a counsel-readable report with proofs
  and an on-chain licence receipt. Needs no hardware, SDK, attestation,
  marketplace, token or L1.
- **Later products:** Recorder SDK (sign at capture, Phase D), attestation
  (Phase D, optional), supplier dashboard (optional).
- **Claim levels** (D-21). Levels are **badges over an L0 base, not a
  cumulative ladder**; the only implication is L2 ⇒ L1. Every surface shows
  the set of badges an episode holds and uses this wording verbatim:

| Badge | Name | Wording (verbatim; `{}` are substitutions) |
| --- | --- | --- |
| L0 | Committed | `Committed — existed by block {block} on {chain}; log unchanged since; consent {live \| revoked at block {onset}} as of anchor (size {size}).` |
| L1 | Signed | `Signed — {org} signed this record before it was logged; unchanged since.` |
| L2 | Attested | `Attested — signing key held in hardware attested by {manufacturer} ({model}); this proves which device signed, not what its sensors saw.` |
| L3 | Checked | `Checked by {operator} — {n} checks run: {list}. Heuristic; see details.` |
| — | Pending | `Pending — received, not yet anchored.` (not a level) |
| — | Check failed | `Check {name} failed: {summary}.` (appended whenever any claim is `fail`) |

Forbidden words on any surface for any level: *authentic, genuine, real,
proven real, verified* (except inside "Checked by … see details" wording),
*independent* (until third-party verifiers exist). Test: T-021 grep guard.

## 2. Current architecture (as of `11facc8`)

| Component | Location | State |
| --- | --- | --- |
| CT log (RFC 6962), inclusion + consistency | `packages/protocol/src/log.ts`, `contracts/src/lib/MerkleLog.sol` | Done, vectored |
| Sparse Merkle revocation tree | `packages/protocol/src/sparse.ts`, `contracts/src/lib/SparseMerkle.sol` | Done, vectored |
| Leaf 0x01 `ClipLeaf` (154 B), 0x02 `EpisodeLeaf` (197 B) | `leaf.ts`, `episode.ts`, `lib/ClipLeaf.sol`, `lib/EpisodeLeaf.sol` | Done, frozen |
| `GraspLog` | `contracts/src/GraspLog.sol` | v1 could not anchor revocation-only changes (fixed by T-005, D-17) |
| `LeafVerifier` | `contracts/src/LeafVerifier.sol` | v1 0x01/0x02; T-005 extends to 0x04 |
| `TaskRegistry`, `FoundryMarket`, `GraspMarket` | `contracts/src/` | Deleted by T-006 (D-22, D-14) |
| Log store (SQLite), anchorer, CLI | `services/log/src/` | v1: no HTTP, unauthenticated revoke, O(n) roots — fixed by T-004/T-007/T-014 |
| JSONL "exporter" | `services/export/` | Deleted in T-034 |
| TaskSpec, sampler, embodiments | `packages/protocol/src/` | Kept as optional `sim` metadata and joint limits |
| Static site | `apps/web/` | Reads chain directly; Monad strings removed by T-029; `/build` → `/lab` by T-034 |
| Deployment | Monad testnet (v1, historical); Fuji zero addresses | v2 deploys Fuji + Sepolia (T-009) |

## 3. Target architecture

```
 Supplier ──upload files (PUT by hash)──▶ bundle store (content-addressed) ─┐
 Supplier ──manifests──▶ ingest/commit ──▶ leaves ──▶ CT log (SQLite, append-only, cached nodes) ──▶ anchorer ──▶ GraspLog @ primary (Avalanche C-Chain / Fuji)
 Contributor/Org ──signed revocation──▶ consent service ──▶ SMT ────────────┘                              ╰──▶ GraspLog @ mirror (Ethereum / Sepolia)
 Verifier (THENAR) ──checks──▶ claim leaves ──▶ CT log
 Buyer ──USDC──▶ LicenceRegistry @ primary (terms, sealed corpora, receipts)
 API ──▶ proofs, consent status, corpus, report (JSON+PDF), receipt-gated download
 /verify (static) ──▶ any chain's GraspLog + API proofs; offline verifier CLI ──▶ files + report
```

## 4. Architecture decisions (index; reasoning in `docs/ARCHITECTURE-DECISIONS.md`)

| ID | One line |
| --- | --- |
| D-1 | Chain anchors the log; never holds leaves, payloads, identities. |
| D-2 / D-23 | No chain-specific value in leaves/manifests; anchors identified by `(root, size)`. |
| D-3 | Corpus = own tree over selected episode leaf hashes; manifest leaf (0x03) logged; `sealCorpus` proves its inclusion. |
| D-4 / D-18 | `payloadHash` = CT root over file leaves; commit to container files as delivered + `range`; no slicing/re-encoding. |
| D-5 / D-28 | JCS; set-like arrays sorted by schema rule; validation rejects unsorted. |
| D-6 / D-26 | keccak256; Ed25519 (software keys), P-256 (hardware keys), secp256k1 (EVM). |
| D-7 / D-19 | Consent per episode; signed revocation; record names holder. |
| D-8 | Verification results are signed leaves (0x04). |
| D-9 | Avalanche C-Chain primary, Ethereum mirror, identical bytecode; `LicenceRegistry` primary only. |
| D-10 | Relayer EOA anchors; Safe 2-of-3 controls it. |
| D-11 / D-22 | ERC-20-only settlement; payees supplier + protocol; no curator, no `TaskRegistry`. |
| D-12 / D-24 | SQLite with append-only triggers and cached nodes; Postgres deferred. |
| D-13 | Simulation foundry shelved; `TaskSpec`/sampler kept as metadata. |
| D-14 / D-15 | One registry, one stateless verifier; `GraspLog` parses no leaves. |
| D-16 | No token, staking, slashing, ZK, TEE. |
| D-17 | Anchor rule: size non-decreasing; equal size ⇒ same root, changed revocation root. |
| D-20 | Key validity evaluated at the leaf's first primary-chain anchor timestamp. |
| D-21 | Levels are badges; fixed wording; L3 = "Checked by {operator}". |
| D-25 | L2 is Phase D, optional; supported devices listed; Quest unverified. |
| D-27 | Terms keyed by `termsHash` (bytes32); no numeric terms id. |
| D-29 | W1 reads chain state directly with a short cache; no indexer. |

## 5. System invariants

| ID | Invariant | Why | Enforced by |
| --- | --- | --- | --- |
| I-1 | Integrity is never presented as truth: every surface shows badges with §1 wording; forbidden words never appear. | Credibility of the product. | T-021 wording snapshot + grep guard in CI |
| I-2 | Leaves and anchors are append-only; the head never shrinks. | Provenance cannot be rewritten. | SQLite triggers (T-014); `GraspLog` rule D-17; invariant tests (T-032) |
| I-3 | Revocation never rewrites history: leaf stays; SMT entry added; onset proven. | Buyers must show what was true when they bought. | T-004, T-012 tests |
| I-4 | Every commitment cites the §10 rule defining its exact bytes. | Third-party reproducibility. | Code review; vectors |
| I-5 | Canonical serialisation is deterministic; TS and Solidity agree on every vector. | A drifted hash breaks every proof silently. | T-008 vectors in CI |
| I-6 | Nothing on chain or in a leaf identifies a person; consent commitments re-salted per leaf; consent records per episode. | Erasure and unlinkability. | T-004; leaf byte scan test |
| I-7 | No chain-specific data in leaves or manifests. | D-2. | Schema rejects `chain_id`; grep test |
| I-8 | A receipt names `(termsHash, corpusManifestHash, corpusRoot)`; terms are append-only. | A receipt is useful only if it names what was bought. | T-006 tests |
| I-9 | Public interfaces (leaf layouts, ABIs, HTTP paths, schema versions) change only by ADR; changes add versions. | Downstream verifiers depend on them. | §26 STOP |
| I-10 | Security-sensitive code (`MerkleLog`, `SparseMerkle`, leaf codecs, canonical JSON, signatures, anchorer) is not refactored without FRONTIER review. | Subtle drift. | §26 STOP; T-030 suite |
| I-11 | The service never invents a value: no placeholder roots, proofs, samples or rows. | Same rule the site follows. | T-031 fault tests |
| I-12 | Raw sensor data never touches the chain or the log database. | Cost, privacy. | Schema; code review |
| I-13 | A verifier signs what it claims; unsigned or unregistered claims are refused. | Attribution of L3. | T-020 tests |
| I-14 | Key validity is evaluated at first-anchor time (D-20). | Back-dating resistance. | T-021, T-020 tests |
| I-15 | Thresholds and versions of every check are recorded in the claim `detail`; a claim without them is invalid. | A heuristic must never become an unrecorded guarantee. | T-020 schema |

## 6. Trust model

| Party | Trusted for | Not trusted for | Mitigation |
| --- | --- | --- | --- |
| THENAR (anchorer) | Not forking the head (chain-enforced); anchoring on time | Not omitting leaves; not fabricating leaves | Signed append receipts held by suppliers; `/anchors/audit`; mirrors; Safe-controlled relayer |
| THENAR (verifier) | Running the checks it names | Being right | Thresholds recorded per claim; claims signed and disputable; third-party verifiers later |
| Supplier | Its signature (L1) | Physical truth of content; `captured_at`; `source` | L3 checks; wording |
| Device manufacturer | Attestation chain (L2) | Anything above the key | Roots pinned; level capped at L2 |
| Contributor / holder | Owning the consent key | — | Revocation signed |
| Chain | Ordering, timestamps, receipt immutability | RPC availability | Mirrors; user-supplied RPC on `/verify` |
| Buyer | Paying | — | Receipt-gated delivery |

### 6.1 Revocation matrix (D-19; do not conflate the three columns)

| After onset at anchor *A* | Provenance | Rights | Access |
| --- | --- | --- | --- |
| The episode leaf | stays in the log forever; inclusion proofs valid at every anchor | — | — |
| Consent status | `verifyConsentLive` false at anchors ≥ *A*; onset provable | — | — |
| Existing receipts (before *A*) | remain valid and auditable against their anchor | what the buyer may still do is set by the terms document (FD-4); the protocol records onset only | files already delivered are not clawed back by the protocol |
| New corpora | the log service refuses to include the episode in a manifest logged after *A* (`unprocessable`, `consent_revoked`) | cannot be licensed | not delivered |
| Existing sealed corpora containing it | receipt still names the same root | `license()` is not blocked on chain (revocation is off-chain); the API marks the corpus `contains_revoked: true` and the report shows it; steward closes the corpus | new buyers are shown the flag before paying |

Who may revoke: the holder of the consent record's private key — the
contributor when the SDK issued the record, the supplier organisation under
W1 (`holder: "organisation"`). The report states the holder.

## 7. Threat model

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

## 8. Domain model

Identifiers: `Hex32` = `0x` + 64 lowercase hex; `ULID` for off-chain rows;
timestamps are unix seconds (uint64). Off-chain rows live in SQLite (§14).

| Entity | Identifier | Key fields | Owner | Mutability | Lifecycle |
| --- | --- | --- | --- | --- | --- |
| Organisation | `orgId: ULID` | `name`, `kind: supplier\|buyer\|verifier` | THENAR admin | fields editable; id fixed | active → suspended |
| SigningKey | `keyId = keccak(pubkeyBytes)` | `alg: ed25519\|p256\|secp256k1`, `pubkey`, `orgId`, `validFrom`, `validTo?`, `attestation?` | Org | append-only; `validTo` set once | active → expired/revoked |
| Device (Phase D) | `deviceId: Hex32 = keccak(orgId ‖ serial)` | `orgId`, `model`, `firmware?`, `attestationRoot?`, `level: 1\|2` | Org | attestation appended | registered → retired |
| CaptureSession (Phase D) | `sessionId: Hex32` | `deviceId`, `sessionKeyId`, `startedAt`, `endedAt?` | Org | ends once | open → closed |
| Dataset | `datasetId: ULID` | `orgId`, `sourceUri?`, `infoJsonHash`, `files[] (FileEntry)`, `status` | Org | files append-only | uploading → committed |
| Upload | `hash: Hex32` | `bytes`, `orgId`, `status: pending\|stored` | Org | immutable once stored | pending → stored |
| Episode | `leafHash: Hex32` | `leafIndex`, `preimage`, `manifest`, `manifestHash`, `payloadHash`, `datasetId?`, `orgId`, `consentKey`, `submittedAt` | Org (content) / THENAR (log) | immutable | logged → anchored |
| Consent | `consentKey: Hex32` | `record (§9.4)`, `recordHash`, `holder` | holder | immutable; revocable | live → revoked(onset) |
| Revocation | `consentKey` | `value`, `signature`, `receivedAt`, `firstAnchor?: (root,size)` | holder | immutable | pending → anchored |
| Anchor | `(root, size)` | `prevRoot`, `revocationRoot`, `chains[]: {chainId, index, at, blockNumber, txHash}` | chain | immutable | — |
| Corpus | `corpusId: ULID` | `manifest (§9.2)`, `corpusManifestHash`, `corpusRoot`, `manifestLeafHash?`, `manifestLeafIndex?`, `onChainId?`, `status`, `containsRevoked` | Org | draft mutable; logged immutable | draft → logged → sealed → closed |
| Terms | `termsHash: Hex32` | `documentBytesRef`, `uri`, `publishedAt`, `retired` | steward | retire only | — |
| Receipt | `receiptId: uint` (chain) | `buyer`, `corpusOnChainId`, `termsHash`, `corpusRoot`, `corpusManifestHash`, `amount`, `token`, `at`, `blockNumber` | chain | immutable | — |
| VerificationClaim | `leafHash` of 0x04 | §9.3 | verifier | immutable | logged → anchored |
| Verifier | `keyId` (a SigningKey with role verifier) | `checks[]` | THENAR admin | append | — |
| Report | `reportId: ULID` | `corpusId`, `anchor (root,size)`, `reportHash`, `jsonRef`, `pdfRef`, `generatedAt` | THENAR | immutable | — |

Relationships: Organisation 1—* SigningKey, Dataset, Episode, Corpus.
Dataset 1—* Upload (by hash), 1—* Episode. Episode 1—1 Consent. Corpus *—*
Episode (corpus tree). Corpus 1—* Receipt. Episode 1—* VerificationClaim.
No entity references a chain id except `Anchor.chains[]`, `Receipt`.

## 9. Data schemas

All JSON objects carry `"v"` and `"kind"` and hash as `keccak256(utf8(JCS(object)))`
(D-5). **Set-like arrays are sorted by the stated key and validation rejects
unsorted or duplicate entries** (D-28). Field order below is documentation.

### 9.1 CaptureManifest v1

```jsonc
{
  "v": 1,
  "kind": "capture_manifest",
  "org_id": "01J…",                         // ULID
  "dataset_id": "01J…" | null,
  "source": "real" | "sim" | "mixed",       // a claim
  "layout": "chunked" | "per_episode",      // chunked: files contain several episodes; range required
  "embodiment": "so_arm100",                // registry id or free string
  "rate_hz": 30,
  "duration_ms": 12400,
  "captured_at": 1756900000,                // a claim (unix s)
  "channels": [                             // SORTED by name (bytewise), unique
    { "name": "action", "dtype": "float32", "shape": [6], "hz": 30 },
    { "name": "observation.images.front", "dtype": "video/mp4", "shape": [480, 640, 3], "hz": 30 },
    { "name": "observation.state", "dtype": "float32", "shape": [6], "unit": "rad", "hz": 30 }
  ],
  "files": [                                // SORTED by path (UTF-8 bytes), unique; exactly the §10.4 inputs
    { "path": "data/chunk-000/file-000.parquet", "bytes": 104857600, "hash": "0x…" },
    { "path": "videos/observation.images.front/chunk-000/file-000.mp4", "bytes": 734003200, "hash": "0x…" }
  ],
  "range": null | { "episode_index": 42, "frames": [1200, 1613], "video": { "observation.images.front": [40.0, 53.77] } },
  "payload_hash": "0x…",                    // §10.4 over `files`; server recomputes and must match
  "consent_commitment": "0x…",              // §10.5
  "terms_hash": "0x…",                      // keccak256 of the terms document bytes
  "scope_bits": 11,
  "task": null | { "instruction": "fold the towel", "task_id": "0x…" | null },
  "outcome": null | { "success": true },
  "sim": null | { "task_spec_hash": "0x…", "world_seed": "12345" },   // decimal string, fits uint64
  "signature": null | { "alg": "ed25519" | "p256", "key_id": "0x…", "sig": "0x…" }  // excluded from manifestHash
}
```
Required: `v, kind, org_id, source, layout, embodiment, rate_hz, duration_ms,
captured_at, channels, files, payload_hash, consent_commitment, terms_hash,
scope_bits`; `range` required iff `layout == "chunked"`. Path rule: relative,
`/`-separated, no `..`, no leading `/`, no byte 0x1f, first byte in
`[A-Za-z0-9]`. Any key not in this schema → `invalid_request` (closed schema;
this is what rejects `chain_id`).

`manifestHash = hashObjectExcluding(manifest, ["signature"])`.

### 9.2 CorpusManifest v1

```jsonc
{ "v": 1, "kind": "corpus_manifest", "org_id": "01J…", "title": "…",
  "episodes": ["0x…", …],                   // episode leaf hashes SORTED by log index ascending, unique
  "corpus_root": "0x…",                     // §10.7
  "episode_count": 2,
  "terms_hash": "0x…",
  "task_id": "0x…" | null,
  "filters": { "min_badges": ["L0"], "exclude_failed_checks": true },
  "sealed_at": 1756900000 }
```
`corpusManifestHash = hashObject(m)`.

### 9.3 VerificationClaim v1

```jsonc
{ "v": 1, "kind": "verification_claim", "subject_leaf": "0x…", "verifier_key_id": "0x…",
  "check": "dedup.v1" | "timing.v1" | "kinematics.v1" | "sensor_consistency.v1" | "sim_signature.v1" | "attestation.v1",
  "result": "pass" | "fail" | "inconclusive",
  "level_asserted": 3,
  "detail": { "check_version": "…", "thresholds": { … }, "index_snapshot": "…", /* check-specific */ },   // thresholds REQUIRED (I-15)
  "issued_at": 1756900000,
  "signature": { "alg": "ed25519", "key_id": "0x…", "sig": "0x…" } }
```
`detailHash = hashObject(detail)`; signature over `message("claim", hashObjectExcluding(claim, ["signature"]))`.

### 9.4 ConsentRecord v1 (one per episode, D-19)

```jsonc
{ "v": 1, "kind": "consent_record", "holder": "contributor" | "organisation",
  "pubkey": "0x…", "alg": "ed25519" | "p256", "scope_bits": 11, "terms_hash": "0x…",
  "granted_at": 1756900000, "nonce": "0x…" }   // nonce: 16 fresh random bytes per episode
```
`recordHash = hashObject(record)`; `consentKey = keccak256(0x02 ‖ recordHash)`.

### 9.5 AppendReceipt v1
```jsonc
{ "v": 1, "kind": "append_receipt", "leaf_hash": "0x…", "leaf_index": 17, "log_size_after": 18,
  "received_at": 1756900000, "signature": { "alg": "ed25519", "key_id": "0x…", "sig": "0x…" } }
```
Signed by the log service key over `message("append-receipt", hashObjectExcluding(r, ["signature"]))`.

### 9.6 Report v1 — normative fields
```
{ v:1, kind:"provenance_report", report_id, generated_at, operator:{ name, verifier_key_id },
  corpus:{ id, manifest_hash, corpus_root, episode_count, terms:{ hash, uri }, contains_revoked,
           on_chain: null | { chain_id, registry, corpus_id, tx } },
  anchor:{ root, size, revocation_root, chains:[{ chain_id, index, block_number, at, tx }] },   // the report anchor
  sealing_anchor:{ root, size, chains:[…] }, consistency_proof:[…],                            // sealing → report anchor
  episodes:[{ leaf, log_index, corpus_index, badges:["L0","L3"], wording:[…], manifest_hash, payload_hash, preimage,
              files:[{ path, hash, bytes }], range, inclusion_proof_log:[…], inclusion_proof_corpus:[…],
              consent:{ key, holder, status, bitmap, siblings, onset? }, claims:[{ check, result, leaf, log_index, verifier_key_id, detail_hash, detail }],
              signature?:{ key_id, alg, org } }],
  receipts:[…], checks_run:[{ check, check_version, thresholds }], limitations:[ …verbatim from §22… ],
  report_hash }
```
`report_hash = hashObjectExcluding(report, ["report_hash"])`.

### 9.7 Versioning
`v` bumps only by ADR. New leaf versions get a new byte and length; old
versions verify forever (I-9).

## 10. Cryptographic specification

`H` = keccak256. `‖` = byte concatenation. Integers big-endian fixed width.
Hex lowercase. `utf8()` = UTF-8 bytes without BOM or terminator.

### 10.1 CT log (unchanged, RFC 6962 with keccak)
Leaf hash `H(0x00 ‖ preimage)`; node `H(0x01 ‖ l ‖ r)`; root of *n*: split at
largest power of two `k < n`; single leaf = the leaf hash; `size ≥ 1` always.
Inclusion proof: siblings leaf-to-root, side derived from index. Consistency:
RFC 6962 §2.1.2; equal sizes ⇒ empty proof and equal roots.

### 10.2 Sparse Merkle revocation tree (unchanged)
256-bit key space; level 0 leaf; bit *i* of key = side at level *i* (1 =
right). Node `H(l ‖ r)`, `H(0,0) = 0`; leaf value must be non-zero.
Membership folds `value`; non-membership folds `0`. Compact proof
`(bitmap, siblings)`. Revocation value = `H(recordHash ‖ utf8("revoked"))`.

### 10.3 Leaf formats (version byte first; fixed width; encoders reject any other length)
- **0x01 ClipLeaf, 154 B** — frozen (`ClipLeaf.sol`).
- **0x02 EpisodeLeaf, 197 B** — frozen (`EpisodeLeaf.sol`); field mapping in §10.12; `qualityScore` is reserved and always 0 in v2.
- **0x03 CorpusManifestLeaf, 145 B**

| off | size | field |
| --- | --- | --- |
| 0 | 1 | version = 0x03 |
| 1 | 32 | corpusManifestHash |
| 33 | 32 | corpusRoot |
| 65 | 32 | termsHash |
| 97 | 32 | taskId (0 if none) |
| 129 | 8 | episodeCount (≥ 1) |
| 137 | 8 | sealedAt |

- **0x04 VerificationClaimLeaf, 141 B**

| off | size | field |
| --- | --- | --- |
| 0 | 1 | version = 0x04 |
| 1 | 32 | subjectLeaf |
| 33 | 32 | verifierKeyId |
| 65 | 32 | detailHash |
| 97 | 32 | signatureHash = H(sig bytes) |
| 129 | 2 | checkId (§10.9) |
| 131 | 1 | result (0 fail, 1 pass, 2 inconclusive) |
| 132 | 1 | levelAsserted (≤ 4) |
| 133 | 8 | issuedAt (≥ 1) |

### 10.4 payloadHash (D-4, D-18)
For each manifest file: `fileLeaf = H(0x00 ‖ utf8(path) ‖ 0x1f ‖ H(fileBytes))`.
Sort by `utf8(path)` ascending (bytewise). `payloadHash = ctRoot(fileLeaves)`
with §10.1 **node** rules and the `fileLeaf` values used **directly as
level-0 nodes** (no second 0x00). One file ⇒ its `fileLeaf`. Zero files ⇒
invalid. `files[i].hash` must equal `H(fileBytes)`; the server recomputes
from stored uploads before accepting a manifest. Two episodes in the same
chunk may share a `payloadHash`; their `manifestHash` differs by `range`.

### 10.5 Consent commitment
`consentCommitment = H(recordHash ‖ salt)`, `salt` = 32 fresh random bytes per
episode, held by the holder/supplier, never stored in the log DB. `consentKey`
(§9.4) is the SMT key and appears in reports; because records are
per-episode it links nothing.

### 10.6 Signatures
Message bytes: `utf8(domain) ‖ 0x00 ‖ objectHash` with `domain ∈
{"THENAR/v1/manifest", "THENAR/v1/revoke", "THENAR/v1/claim", "THENAR/v1/append-receipt"}`.
`objectHash`: manifest → `manifestHash`; revoke → `consentKey`; claim →
`hashObjectExcluding(claim, ["signature"])`; append-receipt → same rule.
- `ed25519` (RFC 8032): pubkey 32 B; sig 64 B; reject non-canonical S and
  small-order points (`@noble/ed25519` default strict verify).
- `p256`: ECDSA over SHA-256(message bytes); pubkey 65 B uncompressed SEC1
  (`0x04‖x‖y`); sig `r‖s` 64 B, low-S required.
- `keyId = H(pubkeyBytes)` exactly as encoded above.
- **Validity (D-20):** a signature is accepted iff the key's
  `[validFrom, validTo)` contains the **timestamp of the first primary-chain
  anchor covering the signed object's leaf**; for a not-yet-anchored leaf,
  the current time is used provisionally and re-evaluated at anchor time.

### 10.7 Corpus tree
`corpusRoot = ctRoot(episodeLeafHashes)` — leaf hashes (already
`H(0x00‖preimage)`) used directly as level-0 nodes; §10.1 node rules; order
= ascending log index. Corpus inclusion proof = §10.1 inclusion against
`corpusRoot`.

### 10.8 (removed — no cap table in v2)

### 10.9 Check ids and parameter classes
Ids: `0x0001 dedup.v1`, `0x0002 timing.v1`, `0x0003 kinematics.v1`,
`0x0004 sensor_consistency.v1`, `0x0005 sim_signature.v1`,
`0x0006 attestation.v1`. Append-only.

| Class | Examples | Who sets | Where recorded |
| --- | --- | --- | --- |
| Protocol constant | check ids, result codes, leaf layout | ADR | this file |
| Implementation detail | LSH table count, DTW band, resampling rate | task | code + `detail.check_version` |
| Configuration | thresholds (`T_exact`, `ρ_min`, …), enable/blocking flags | FRONTIER (FD-1, FD-2) | `detail.thresholds` on every claim (I-15) + `config/checks.json` |
| Research variable | fingerprint design, feature set | FRONTIER | `check_version` bump |

A check whose thresholds are not yet FRONTIER-approved emits only `pass` /
`inconclusive`, never `fail`, and is marked `blocking: false` in config.

### 10.10 Verification procedure (what a third party runs; `scripts/verify-report.mjs`)
1. For each delivered file: `H(fileBytes)` equals `files[].hash`; rebuild `payloadHash` (§10.4) and compare.
2. Recompute `manifestHash`; if `signature` present, verify per §10.6 against the org's published key valid at the leaf's first-anchor time.
3. Rebuild the 0x02 preimage from §10.12 + `submittedAt` (delivered in report); leaf hash; inclusion against the report anchor `(root,size)` read from **any** chain carrying the log (`indexOfRoot` lookup).
4. Consistency proof from the sealing anchor to the report anchor.
5. Consent non-membership at the report anchor; if revoked, onset.
6. Each claim leaf: inclusion; verifier signature over the claim; `detailHash` matches `detail`; thresholds present.
7. Corpus inclusion against `corpusRoot`; corpus manifest leaf inclusion; `corpusRoot`/`corpusManifestHash` equal the on-chain corpus and receipt.

### 10.11 Pseudocode — leaf 0x03
```
enc03(m): out = 0x03 ‖ m.corpusManifestHash ‖ m.corpusRoot ‖ m.termsHash ‖ (m.taskId or 0^32) ‖ u64(m.episodeCount) ‖ u64(m.sealedAt)
          assert len(out) == 145 ; assert m.episodeCount ≥ 1
leaf = H(0x00 ‖ out)
```

### 10.12 CaptureManifest → EpisodeLeaf (0x02) mapping (normative)

| Leaf field | Source |
| --- | --- |
| version | 0x02 |
| payloadHash | `manifest.payload_hash` (after server recomputation) |
| manifestHash | `hashObjectExcluding(manifest, ["signature"])` |
| consentCommitment | `manifest.consent_commitment` |
| termsId | `manifest.terms_hash` |
| taskId | `manifest.task.task_id` if set; else `H(utf8(manifest.task.instruction))` if instruction set; else `0^32` |
| capturedAt | `manifest.captured_at` |
| submittedAt | server receive time (unix s); returned in the append receipt and stored with the episode |
| durationMs | `manifest.duration_ms` |
| scopeBits | `manifest.scope_bits` |
| channels | `min(len(manifest.channels), 255)` |
| worldSeed | `BigInt(manifest.sim.world_seed)` if `sim` set, else 0 |
| successFlag | `manifest.outcome.success ? 1 : 0`, else 0 |
| qualityScore | 0 (reserved in v2) |

## 11. Smart contracts

Solidity 0.8.24, non-upgradeable, no proxies, identical bytecode on every
chain. `GraspLog` + `LeafVerifier` deploy on primary and mirrors;
`LicenceRegistry` on the primary only (D-9).

### 11.1 `GraspLog` (modified)
- **Storage:** `Anchor[] _anchors {root, prevRoot, revocationRoot, size, at, blockNumber}`, `anchorer`, `pendingAnchorer`, `mapping(bytes32 => uint256) _indexOfRoot` (index+1, first occurrence).
- **`anchor(bytes32 root, uint64 size, bytes32 revocationRoot)`** onlyAnchorer. Rule (D-17), with `h` = current head:
  - first anchor: `size ≥ 1` else `SizeMustGrow(0,0)`;
  - `size < h.size` → `SizeMustNotShrink(h.size, size)`;
  - `size > h.size` and `root == h.root` → `RootMustChange()`;
  - `size == h.size` and `root != h.root` → `RootMustMatchAtSameSize()`;
  - `size == h.size` and `revocationRoot == h.revocationRoot` → `NothingToAnchor()`.
  Emits `Anchored(index, root, prevRoot, revocationRoot, size, at)`.
- **Reads:** `anchorCount()`, `anchorAt(i)`, `head()`, `indexOfRoot(bytes32 root) → (bool, uint256)`.
- **Verification:** `verifyLeafHash(i, bytes32 leaf, bytes32[] proof, uint64 leafIndex)`; `verifyAppendOnly(earlier, later, proof)`; `verifyConsentLive(i, key, bitmap, siblings)`; `revocationOnset(i, OnsetProof)`. **Removed:** `verifyClip`.
- **Stewardship:** `transferAnchorer`/`acceptAnchorer` unchanged.

### 11.2 `LeafVerifier` (extended)
`hashLeaf(preimage)` dispatches 0x01–0x04 (reverts `UnknownLeafVersion`,
`WrongLengthForVersion`); `verifyLeaf(i, preimage, proof, leafIndex)`;
`episodeFacts`; `corpusFacts(p) → (manifestHash, corpusRoot, termsHash, taskId, episodeCount, sealedAt)`;
`claimFacts(p) → (subjectLeaf, verifierKeyId, checkId, result, level, issuedAt)`.

### 11.3 `LicenceRegistry` (replaces `FoundryMarket`; D-22, D-27)
- **Storage:** `mapping(bytes32 termsHash => Terms{uri, publishedAt, retired, exists})`; `Corpus[] {corpusManifestHash, corpusRoot, termsHash, episodeCount, supplier, price (uint128), token, open, sealedAt, anchorRoot, anchorSize}`; `Receipt[] {buyer, corpusId, termsHash, corpusRoot, corpusManifestHash, amount, token, at, blockNumber}`; `mapping(address => uint256[]) _byBuyer`; `mapping(address who => mapping(address token => uint256)) credited`; `treasury`, `steward`, `pendingSteward`; `PROTOCOL_BPS = 250`.
- **`publishTerms(bytes32 termsHash, string uri)`** onlySteward; `termsHash != 0` (`ZeroTermsHash`); not already published (`TermsExists`). **`retireTerms(termsHash)`** onlySteward.
- **`sealCorpus(SealParams p, bytes preimage03, bytes32[] logProof, uint64 leafIndex, uint256 anchorIndex)`** where `SealParams {corpusManifestHash, corpusRoot, termsHash, episodeCount, supplier, price, token}`:
  1. `msg.sender == p.supplier || msg.sender == steward` else `NotSupplier`;
  2. terms exist and not retired; `price > 0`; `token != 0`;
  3. `leaf = verifier.hashLeaf(preimage03)`; `log.verifyLeafHash(anchorIndex, leaf, logProof, leafIndex)` true else `CorpusNotLogged`;
  4. `verifier.corpusFacts(preimage03)` fields equal `p.*` else `FactsMismatch(field)` (0..3: corpusManifestHash, corpusRoot, termsHash, episodeCount);
  5. push corpus (`open = true`, `anchorRoot/anchorSize` from `log.anchorAt(anchorIndex)`); emit `CorpusSealed(corpusId, corpusManifestHash, corpusRoot, supplier, price, token)`.
- **`license(uint256 corpusId)`** (not payable): corpus open; terms not retired; `IERC20(token).transferFrom(msg.sender, address(this), price)` via low-level call tolerant of no-return tokens (`TransferFailed`); **write the receipt and emit `Licensed` before any payout**; `toProtocol = price*250/10000`, `toSupplier = price − toProtocol`; `_pay(supplier)`, `_pay(treasury)`; `_pay` = low-level `transfer`, credit on failure (`Credited(who, token, amount)`).
- **`closeCorpus(id)`** supplier or steward; **`withdraw(token)`**; reads `termsAt(hash)`, `corpusCount/corpusAt`, `receiptCount/receiptAt`, `receiptsOf(buyer)`; `setTreasury`, `transferSteward`/`acceptSteward` (two-step).
- **Reverts:** `NotSteward, NotSupplier, ZeroTermsHash, TermsExists, UnknownTerms, TermsRetired, ZeroPrice, ZeroToken, CorpusNotLogged, FactsMismatch(uint8), UnknownCorpus, CorpusClosed, TransferFailed, NothingCredited`.
- **Security:** state before external calls; no `payable`; two-step steward transfer; nothing upgradeable.

### 11.4 On chain — the complete list
Anchors; terms hash + URI; sealed corpora (hashes, supplier, price, token,
anchor root/size); receipts. Nothing else.

## 12. Backend APIs (`services/api`, Hono, Node 22)

Base `/v1`. Auth: `Authorization: Bearer <org API key>` for org endpoints;
public otherwise. `Idempotency-Key` on every POST (24 h). Errors
`{ "error": { "code", "message", "details?" } }`, codes `invalid_request,
unauthorized, forbidden, not_found, conflict, unprocessable, rate_limited,
not_implemented, internal`. Lists paginate with `?cursor=&limit=` (default 50,
max 500) and return `{ items, next_cursor }`. Never a fabricated success (I-11).

| Method | Path | Auth | Body → Response |
| --- | --- | --- | --- |
| POST | `/orgs/{orgId}/keys` | org | `{alg, pubkey, attestation?}` → `SigningKey`; 409 if exists |
| GET | `/orgs/{orgId}/keys` | public | list of `{key_id, alg, pubkey, valid_from, valid_to, attestation_level}` |
| POST | `/orgs/{orgId}/keys/{keyId}/revoke` | org | → key with `valid_to = now` |
| POST | `/uploads` | org | `{hash, bytes}` → `{hash, method: "PUT", url, expires_at}` (presigned or `/uploads/{hash}` on local store); 200 `{stored: true}` if already stored |
| PUT | `/uploads/{hash}` | org (local store only) | raw bytes → 201; 422 `hash_mismatch` |
| POST | `/uploads/{hash}/complete` | org (S3 only) | → `{stored: true}` after server-side verification |
| POST | `/datasets` | org | `{source_uri?, info_json_hash, files:[FileEntry]}` → `Dataset` (all hashes must be stored uploads) |
| POST | `/datasets/{id}/ingest` | org | `{terms_hash, scope_bits, source, consent: {holder, pubkey, alg, scope_bits}}` → `{job_id}` (T-011/T-036) |
| GET | `/jobs/{jobId}` | org | `{status, episodes:[{episode_index, leaf_hash, leaf_index, receipt}], errors:[…]}` |
| POST | `/episodes` | org | `{manifest}` → `{leaf_hash, leaf_index, submitted_at, receipt}` (files must be stored; §9.1 validated; §10.4 recomputed) |
| GET | `/episodes/{leafHash}` | public | `{preimage, leaf_index, submitted_at, badges, wording, claims, anchor?}` |
| GET | `/proofs/inclusion?leaf=&root=&size=` | public | `{index, size, root, proof}`; leaf not covered → 404 |
| GET | `/proofs/consistency?from_size=&to_size=` | public | `{proof}` |
| GET | `/consent/{consentKey}?root=&size=` | public | `{status: live\|revoked\|pending, holder, bitmap, siblings, onset?}` |
| POST | `/consent/{consentKey}/revoke` | public, rate-limited | `{record, signature}` → `{accepted, received_at, receipt}`; 401 bad signature |
| POST | `/corpora` | org | `CorpusManifest` (without `corpus_root`/`episode_count`, computed) → `Corpus` |
| POST | `/corpora/{id}/log` | org | → `{leaf_hash, leaf_index}`; 422 `consent_revoked` listing episodes |
| GET | `/corpora/{id}/seal-params` | org | → `{seal_params, preimage03, log_proof, leaf_index, anchor:{root,size,chains}}` |
| GET | `/corpora/{id}` | public | corpus + on-chain state (D-29) + `contains_revoked` |
| GET | `/corpora/{id}/report` | public | Report JSON; `?format=pdf` |
| POST | `/claims` | verifier | `VerificationClaim` → `{leaf_hash, leaf_index}` |
| GET | `/anchors` | public | list of `Anchor` (root, size, chains[]) |
| GET | `/anchors/audit` | public | per chain, per anchor: `coherent\|unverifiable\|mismatch` |
| GET | `/licences/{receiptId}/download` | wallet sig header | `{corpus_id, files:[{path, hash, bytes, url, expires_at}]}` |
| GET | `/healthz` | public | `{ok}` |

Authorization: an org acts only on its own rows; `/claims` requires a key
with role `verifier`; steward actions (terms) are CLI-only.

## 13. Frontend architecture
Static, no bundler. `/verify` v2 (chain selector from `chains.js`, leaf
0x01–0x04, report verification, badges + wording); `/corpus/{id}` (report
view, licence instructions); `/protocol`, `/company`, `/products`. `/build`
moves to `/lab/build` (T-034). No chain name in copy (T-029).

## 14. Storage
- **SQLite** (`services/log`, WAL): tables `org, api_key, signing_key, dataset,
  upload, leaf, node, anchor, anchor_chain, revocation, corpus, corpus_episode,
  claim, report, idempotency, job`. Triggers: `BEFORE UPDATE OR DELETE ON leaf,
  anchor, anchor_chain, revocation, claim → RAISE(ABORT)`. `node(level, idx, hash)`
  caches subtree hashes so `root(upTo)` and proofs are O(log n).
- **Bundle store:** interface with local-disk and S3 implementations; key =
  keccak hex; immutable; delivery via short-lived signed URLs.
- Postgres: deferred (D-24).

## 15. Chain reads (D-29)
`services/api/src/chain.ts`: viem clients per chain from `.env.contracts`;
reads `anchorCount/anchorAt/indexOfRoot`, `corpusAt`, `receiptAt`,
`receiptsOf` with a 15 s cache; no event indexer in W1.

## 16. Implementation phases

| Phase | Goal | Tasks |
| --- | --- | --- |
| **A — Protocol v2** | canonical JSON, payloadHash, leaves 0x03/0x04, consent + signed revocation, manifest schema + mapping, contracts, anchorer, vectors, deploy | T-001, T-002, T-003, T-004, T-035, T-005, T-006, T-007, T-008, T-009 |
| **B — Log service** | API skeleton, store hardening, uploads/bundle store, org keys, dataset reader, commit, proofs, daemon, chain reads | T-010, T-014, T-015, T-024, T-011, T-036, T-012, T-013, T-016 |
| **C — Checks** | timing, kinematics, dedup, consistency/sim, claim issuance, badges | T-018, T-017, T-019, T-020, T-021 |
| **E — Wedge product** | report, verify v2, licence script + page, copy, adversarial suite, review pack, golden demo | T-025, T-026, T-027, T-029, T-030, T-032, T-033 |
| **D — Capture (post-wedge, optional)** | SDK, attestation, devices/sessions | T-022, T-023, T-037 |
| **F — Hygiene (any time)** | shelve foundry, observability | T-034, T-031 |

## 17. Dependency graph
See `TASKS/README.md` (single source for order).

## 18. Testing strategy
Unit (TS) for every codec, JCS, payloadHash, SMT, CT, signatures, badges;
vectors TS → Solidity + JSON; contract tests for every revert/event/transition
with fuzz on `MerkleLog`/`SparseMerkle`/splits; D-17 anchor-rule matrix;
manifest array-order rejection; §10.12 mapping rows; validity-at-anchor-time;
wording guard; per-episode consent unlinkability; adversarial suite (T-030);
integration on Anvil; golden demo on Fuji + Sepolia; fault injection (T-031).

## 19. Security strategy
Safe-controlled relayer; append-only key records; strict signature checks;
closed schemas; rate limits; receipt-gated delivery; Slither + invariants in
CI; external review before mainnet USDC; FD-4 before mainnet.

## 20. Observability
`log_size`, `anchor_lag_seconds{chain}`, `ingest_queue`, `verification_queue`,
`claims_total{check,result}`, `revocations_total`, `api_errors_total{code}`.
Alerts: anchor lag > 2× interval; audit mismatch; mirror divergence.

## 21. Golden demo path (minimum; extensions marked)

1. **Ingest.** Upload a public LeRobot v3 dataset (fixture or
   `lerobot/svla_so101_pickplace`); `POST /datasets` + `/ingest`; every
   episode gets a manifest, a leaf, and an append receipt; one extra episode
   is injected as a jittered copy of episode 2 (state + N(0, 1°)).
2. **Check.** `timing.v1`, `kinematics.v1`, `dedup.v1` run; the injected
   episode gets `dedup.v1 = fail` (or `inconclusive` until FD-1); claim
   leaves logged.
3. **Anchor.** Head anchored on Fuji and Sepolia; `/verify` shows the same
   `(root, size)` on both.
4. **Corpus.** Manifest over the passing episodes logged; after the next
   anchor, `sealCorpus` from the supplier wallet (script).
5. **Licence.** Buyer script approves mock USDC and calls `license()`;
   receipt names `corpusRoot`, `corpusManifestHash`, `termsHash`; split lands.
6. **Deliver + verify offline.** Buyer downloads via receipt-gated URLs;
   `scripts/verify-report.mjs` runs §10.10 against files + report: all pass.
7. **Revoke.** The consent holder signs a revocation for one episode; the
   daemon anchors a revocation-only head (D-17); `/verify` shows *revoked at
   block b* with onset; the buyer's receipt still verifies against the
   sealing anchor (§6.1); `/corpora/{id}` shows `contains_revoked`.
8. **Tamper.** Flip one byte in a downloaded parquet; the verifier names the
   file and the leaf.

Extensions (Phase D): step 1 via the SDK with a signed manifest (L1);
attestation on a supported Android device (L2). The demo never says
"authentic"; it shows badges.

## 22. Known limitations (verbatim in every report)
- The operator (THENAR) can decline to log or anchor a record; append receipts and public audit make this detectable, not impossible.
- Checks are heuristics with recorded thresholds; they can be evaded and can err; they are evidence, not proof.
- A signature proves which key signed, not what a sensor measured; `captured_at`, `source` and `embodiment` are claims by the signer.
- Consent onset is recorded; what a buyer may do after onset is governed by the terms document, not by this protocol.
- Anchors depend on the availability of at least one chain carrying the log; the same log is anchored on more than one.

## 23. Future architecture
Third-party verifiers with dispute windows; multi-operator log (Avalanche L1
candidate); training-run receipts (leaf 0x05); clean-room compute; C2PA
interop; ISO 26264 mapping; Postgres; indexer.

## 24. Definition of Done
Per task: listed files exist/changed; task tests pass; `pnpm test` and
`forge test` pass; no invariant test regressed; report filed
(`TASKS/REPORTS.md`); no `TODO`/mock/placeholder in shipped paths.
Release: §21 steps 1–8 run unattended from a clean checkout against Fuji +
Sepolia.

## 25. Agent execution protocol and model tiers

### 25.1 Tiers
- **FRONTIER:** ADRs, §9–§12 changes, thresholds and enablement of checks,
  attestation roots, terms language, economics, security review.
- **STRONG:** Solidity, services, SDK, checks' implementation, report,
  verify page, adversarial tests.
- **CHEAP:** vectors, deploy scripts, endpoints over existing functions,
  daemons, badge engine, copy, observability, shelving, docs.

### 25.2 Procedure
1. Read the task file and the PLAN sections it cites; read the reports of
   the tasks it depends on.
2. Inspect the listed existing files.
3. List the §5 invariants that apply.
4. Implement only the task; add the named tests.
5. Run `pnpm test:protocol`, `pnpm test:contracts`, and the task's suites.
6. Check §7 for the threats the change touches.
7. File the report (§25.3). If any §26 condition triggered, file
   `TASKS/CONFLICTS.md` and stop.

### 25.3 Report format
```
## T-0NN — <title> — <date> — <tier used>
Changed: … Created: … Deleted: …
Tests: <command> → <pass/fail>
Deviations from PLAN.md: none | …
Invariants touched: …
Open questions / conflicts filed: none | C-n
```

### 25.4 Prohibited
Redesigning architecture; changing leaf layouts, hash rules, signature
messages, ABIs, HTTP paths or schemas; weakening a check; removing or
skipping a failing test; adding dependencies not named in the task; inventing
unspecified behaviour; touching files outside the task without saying why;
**any git command that rewrites the working tree** (`stash`, `checkout --`,
`reset`, `clean`).

## 26. STOP CONDITIONS

An agent **stops, files `TASKS/CONFLICTS.md`, and ends the task** when any of
these holds. It does not "make a reasonable assumption" for these.

1. The task contradicts this file or `docs/ARCHITECTURE-DECISIONS.md`.
2. Required behaviour is unspecified and the task's Edge cases do not cover it.
3. A hash input, serialisation, domain string, key encoding or Merkle rule is ambiguous or would need to change.
4. An invariant in §5 would have to change or be weakened.
5. A public interface (leaf layout, ABI, HTTP path/shape, schema) would have to change.
6. A protocol semantic (anchor rule, revocation semantics, corpus/log relation, level rules) would have to change.
7. A check threshold or its blocking status would change, or a check would emit `fail` before its FD is closed.
8. A trust assumption (§6) or threat control (§7) would change.
9. The agent believes the architecture is wrong or the task cannot meet its acceptance criteria as written.
10. A test that guards an invariant fails and the only fix is to change the test.

## 27. Cheap-model traps (each has a guard)

| # | Trap | Guard |
| --- | --- | --- |
| 1 | Using `JSON.stringify` instead of JCS; relying on JCS to sort arrays | T-001 fixtures; §9 sorted-array validation |
| 2 | Sorting paths by locale/`localeCompare` instead of bytes | T-002 property test with non-ASCII paths |
| 3 | Adding a second `0x00` when building corpus/payload trees from leaf hashes | vectors (T-008) |
| 4 | Encoding leaves with `abi.encode` (padded) instead of `abi.encodePacked` | length assertions; vectors |
| 5 | Anchoring only when size grows; forging `size+1` to carry a revocation | D-17 matrix test; the old e2e trick is deleted |
| 6 | Referencing anchors by index across chains | §9.6 uses `(root,size)`; T-012 tests |
| 7 | Taking `submittedAt` from the manifest | §10.12; T-036 test |
| 8 | Deriving `consentKey` without the `0x02` byte, or reusing one record across episodes | T-004 vectors and unlinkability test |
| 9 | Storing the salt or the consent record in the log DB | T-004 schema; code review |
| 10 | Checking key validity at `captured_at`/`issued_at` | I-14 tests |
| 11 | Treating levels as cumulative, or labelling L3 "verified/independent" | T-021 truth table + grep guard |
| 12 | Hard-coding thresholds without writing them into `detail` | I-15 schema check in T-020 |
| 13 | Emitting `fail` from a check whose FD is open | `config/checks.json` `blocking:false`; T-020 test |
| 14 | Slicing or re-encoding supplier files | D-18; T-011 has no writer dependency |
| 15 | Putting a numeric terms id anywhere | D-27; T-006 tests |
| 16 | Paying out before writing the receipt | §11.3 order; T-006 reentrancy test |
| 17 | `sealCorpus` accepting an anchor by index without checking the root/size it stores | T-006 tests |
| 18 | Returning a placeholder proof/sample when data is missing | I-11 fault tests |
| 19 | Adding `chain_id` (or an address) to a manifest "for convenience" | closed schema; grep test |
| 20 | Deleting/loosening a failing vector test | §26.10 |
| 21 | Presenting fixture data as real in a demo or page | I-1; fixture files carry `source: "sim"` or a `fixture: true` marker in `dataset.source_uri` |
| 22 | Running `git stash`/`checkout --`/`reset` in the shared checkout | §25.4; this happened once on 2026-09-03 and cost an hour |
