# THENAR — build plan

A builder agent should be able to pick any single task below and execute it
without further context. Every task carries a status; every gap names the task
it blocks.

**Audited:** 2026-08-29, against the working tree, not the README.
**Execution pass:** 2026-08-29 — statuses below are post-execution and verified, not aspirational.

---

## 1. What "done" and "winning" mean here

Thenar sells **contact data for physical AI** — the grip-force and slip-
correction signal that decides whether a glass lifts or shatters, which neither
pixels nor joint angles record. GRASP is the settlement layer: it commits
captures to an append-only log, lets a buyer verify a slice without trusting
Thenar, lets a contributor withdraw consent provably, and puts payment and
licence terms in one transaction.

The foundry is the next layer: curators design tasks against real robot
embodiments, contributors produce demonstrations, and licence revenue splits to
whoever made the corpus.

### Done means

1. A curator authors a task in the browser — places objects, drags pose
   envelopes, builds a success predicate, watches it fire — and publishes it
   without writing JSON.
2. A contributor opens that task, drives an embodiment against a **sampled**
   world, and their episode is scored, anchored and paid.
3. A buyer browses corpora, reads a quality distribution, buys a licence, and
   receives **LeRobotDataset v3** they can train on with no adapter.
4. Anyone — not just a buyer — can take an episode and verify against the chain
   that it is in the log, that the log was only appended to, that consent was
   never withdrawn, and rebuild the exact world it was captured in.
5. Curator, contributors and protocol are paid in one transaction, weighted by
   quality, with no value stranded.

### Winning means

The differentiator is **not** that data is on a chain. It is that the market
pays for episodes it is *allowed to train on*: the 2026 pattern is pretrain on
open data, then fine-tune on 5,000–20,000 net-new episodes under a commercial
licence. Buyers are not short of data; they are short of provenance their
counsel will accept. Winning is being the place where that artefact is a
by-product of paying people, plus a contact channel nobody else records.

Losing looks like: a simulated corpus sold as if it were real-hardware data.

### Non-goals (deliberate)

- No own L1. Traffic is tens of transactions a day; an L1 is the first thing a
  reviewer kills.
- No tokenised corpus shares or tradable instrument while pre-revenue.
- No claim that anchoring proves a measurement is *true*. It proves a record
  existed and was not reordered. Calibration is a hardware problem.

---

## 2. Where the project actually is

**Shipped and verified on Monad Testnet (chain 10143), all four `full`-verified
on Sourcify:**

| Contract | Address |
| --- | --- |
| `GraspLog` | `0xe9950e8377787d6d6c4c6bda9e4188925a18da6a` |
| `LeafVerifier` | `0x0d789ee35382e1ea06ed0d82f55dcbf4c6130356` |
| `TaskRegistry` | `0xf99bdc3512b074d7b6d21cb609ff05e54f465d24` |
| `FoundryMarket` | `0x735057412d1ef884a28bc409731a6f91679265f3` |

All four `full`-verified on Sourcify. Recorded in `.env.contracts`, which the
scripts and the selector test read rather than hardcoding an address that drifts.

Superseded (kept readable, no longer referenced): the earlier `GraspLog`
`0x10325941…` carried anchors whose declared size did not match the tree its
root came from, so nothing could ever verify against them. `GraspMarket`
`0x0f87309F…` is superseded by `FoundryMarket`.

Live chain state: 6 anchors over one coherent log (sizes 7 → 30), 1 task,
1 corpus, 1 licence receipt.
Test suites: **72 Solidity tests, 5 TypeScript suites**, all passing.
Live site: https://thenar.io — `/verify` reads the contract directly and now
verifies **both** captures and episodes.

**The honest summary, after this pass:** the settlement and provenance layer
is real, proven, and now *coherent* — there is one persisted log, its anchors
re-derive from stored leaves, and episodes verify on chain. What still does not
exist is the product that produces data: no builder, no simulator, no capture
loop, and **no real trajectory has ever been recorded**. Episodes in the
end-to-end runs are real leaves with real provenance over synthetic payload
hashes and assigned quality scores. That is the honest boundary.

---

## 3. Phases and tasks

Status tags: **DONE** · **IN PROGRESS** · **NOT STARTED** · **BLOCKED**

### Phase 0 — Protocol foundation

| # | Task | Status |
| --- | --- | --- |
| 0.1 | `MerkleLog` — RFC 6962 inclusion + consistency verification | **DONE** |
| 0.2 | `SparseMerkle` — compact non-membership proofs, H(0,0)=0 | **DONE** |
| 0.3 | `ClipLeaf` — 154-byte capture leaf | **DONE** |
| 0.4 | `GraspLog` — monotonic anchor, revocation root, onset reporting | **DONE** |
| 0.5 | `GraspMarket` — terms + payment in one transaction | **DONE** |
| 0.6 | Off-chain reference implementation (`log.ts`, `sparse.ts`, `leaf.ts`) | **DONE** |
| 0.7 | Solidity test vectors generated from the reference implementation | **DONE** |
| 0.8 | On-chain end-to-end proof (`scripts/e2e.mjs`) | **DONE** |

### Phase 1 — Foundry contracts and spec

| # | Task | Status |
| --- | --- | --- |
| 1.1 | `TaskSpec` schema, validator, canonical hashing | **DONE** |
| 1.2 | Deterministic scene sampler, χ²-verified uniform | **DONE** |
| 1.3 | Embodiment registry — 58 models with per-model licence | **DONE** |
| 1.4 | `EpisodeLeaf` — 197-byte leaf with task, seed, success, quality | **DONE** |
| 1.5 | `TaskRegistry` — curator publishing, 30% share cap | **DONE** |
| 1.6 | `FoundryMarket` — corpus sealing, quality split, credit-on-refusal | **DONE** |
| 1.7 | Foundry end-to-end on chain (`scripts/foundry-e2e.mjs`) | **DONE** |
| **1.8** | **Episodes verify on chain via `LeafVerifier`** | **DONE** |
| 1.9 | Version-agnostic verification deployed and proven on chain | **DONE** |
| 1.10 | `FoundryMarket` is canonical; `GraspMarket` superseded and documented | **DONE** |

**Task 1.8 detail.** `GraspLog.verifyClip` (line 141) calls
`ClipLeaf.hashPreimage`, which reverts `UnsupportedVersion` on anything whose
first byte is not `0x01` and `WrongPreimageLength` on anything that is not 154
bytes. An `EpisodeLeaf` is version `0x02` and 197 bytes. **No foundry episode
can be verified on chain today.** Fix by adding a `verifyEpisode(uint256 index,
bytes preimage, bytes32[] proof, uint64 leafIndex)` that dispatches on the
version byte, or a version-agnostic `verifyLeafPreimage` that accepts both
lengths. This requires a redeploy; existing receipts referencing the current log
must keep resolving, so deploy alongside rather than replacing.

### Phase 2 — The world builder (critical path)

Nothing downstream works until a curator can author a task without JSON.

| # | Task | Status |
| --- | --- | --- |
| 2.1 | Vendor MuJoCo Menagerie, pinned per model, licence file copied per directory | **NOT STARTED** |
| 2.2 | Asset pipeline: Menagerie STL/OBJ meshes → glTF, with LODs | **NOT STARTED** |
| 2.3 | MuJoCo WASM build + virtual filesystem loader (XML + meshes) | **NOT STARTED** |
| 2.4 | three.js scene canvas: load embodiment, place/rotate/snap objects | **NOT STARTED** |
| 2.5 | Range authoring — drag pose envelopes, not type numbers | **NOT STARTED** |
| 2.6 | Live sampler preview — reroll seed, watch the scene change | **NOT STARTED** |
| 2.7 | Predicate builder over the 8-verb vocabulary | **NOT STARTED** |
| 2.8 | Live predicate evaluation against the stepped scene | **NOT STARTED** |
| 2.9 | Validation panel wired to `validateTaskSpec` | **NOT STARTED** |
| 2.10 | Object/asset library with categories and instances | **NOT STARTED** |
| 2.11 | Publish flow — canonical hash, wallet sign, `TaskRegistry.publish` | **NOT STARTED** |

### Phase 3 — The capture loop

| # | Task | Status |
| --- | --- | --- |
| 3.1 | Task browser — open tasks, embodiment, reward, fill | **NOT STARTED** |
| 3.2 | Episode runner: draw seed, `sampleScene`, load into MuJoCo WASM | **NOT STARTED** |
| 3.3 | `ee_pose_gripper` control with IK — the only cursor-honest action space | **NOT STARTED** |
| 3.4 | `base_velocity` control for quadrupeds | **NOT STARTED** |
| 3.5 | `whole_body_retarget` gated behind a real input device | **NOT STARTED** |
| 3.6 | Trajectory recording at fixed rate, seed recorded with it | **NOT STARTED** |
| 3.7 | Runtime predicate evaluation → success flag | **NOT STARTED** |
| 3.8 | Quality scoring — placement, smoothness, time against par | **NOT STARTED** |
| 3.9 | Episode submission → 197-byte leaf → batch queue | **NOT STARTED** |

### Phase 4 — Log service, acceptance, anchoring

| # | Task | Status |
| --- | --- | --- |
| 4.1 | Off-chain log service maintaining the CT tree (append, root, proofs) | **DONE** |
| 4.2 | Persistent store (`node:sqlite`), survives restart, 26 checks | **DONE** |
| 4.3 | `anchorHead` anchors the real head; scheduling it is not wired | **IN PROGRESS** — anchoring works and is proven; no cron/daemon yet |
| 4.4 | Inclusion / consistency proofs served by the store and CLI | **DONE** — no HTTP surface yet, CLI only |
| 4.5 | Acceptance pipeline: score, threshold on `minScoreBps`, accept or reject | **NOT STARTED** |
| 4.6 | Duplicate and replay detection (jittered resubmission must be caught) | **NOT STARTED** |
| 4.7 | Withdrawal → sparse tree → anchored, proven on chain | **DONE** — no HTTP endpoint yet, store API only |
| 4.8 | Corpus sealing job → `FoundryMarket.sealCorpus` with real weights | **NOT STARTED** |

### Phase 5 — Export and buyer surface

| # | Task | Status |
| --- | --- | --- |
| 5.1 | **LeRobotDataset v3 export** — Parquet states/actions, MP4, metadata | **NOT STARTED** |
| 5.2 | RLDS / TFRecord export for Open X-Embodiment pipelines | **NOT STARTED** |
| 5.3 | Corpus catalogue page: task, size, quality distribution, price | **NOT STARTED** |
| 5.4 | Free sample pack per corpus | **NOT STARTED** |
| 5.5 | Licence purchase flow in the browser (`FoundryMarket.license`) | **NOT STARTED** |
| 5.6 | Receipt-gated delivery of the corpus | **NOT STARTED** |
| 5.7 | Provenance report: inclusion proofs, consent status, licence version | **NOT STARTED** |

### Phase 6 — Curator and contributor surfaces

| # | Task | Status |
| --- | --- | --- |
| 6.1 | Curator dashboard — tasks, fill rate, earnings | **NOT STARTED** |
| 6.2 | Contributor portfolio — episodes, quality, payouts | **NOT STARTED** |
| 6.3 | Leaderboards by quality, not volume | **NOT STARTED** |
| 6.4 | Withdrawal UI for credited balances (`FoundryMarket.withdraw`) | **NOT STARTED** |
| 6.5 | Curator onboarding guide with a worked reference task | **NOT STARTED** |

### Phase 7 — Verification surface

| # | Task | Status |
| --- | --- | --- |
| 7.1 | `/verify` reads anchors live from the contract | **DONE** |
| 7.2 | One-click sample that genuinely verifies | **DONE** |
| 7.3 | `/verify` accepts 154- and 197-byte preimages, both verified live | **DONE** |
| 7.4 | Consent-status check in `/verify` (`verifyConsentLive`) | **NOT STARTED** |
| 7.5 | Append-only check in `/verify` (`verifyAppendOnly`) | **NOT STARTED** |
| 7.6 | Scene rebuild in `/verify` — show the world from spec + seed | **NOT STARTED** |
| 7.7 | `sample-task.json`, `sample-episode.json` and a fresh capture all live | **DONE** |

### Phase 8 — Trust and diligence

| # | Task | Status |
| --- | --- | --- |
| 8.1 | Per-model licence audit — read all 58 LICENSE files, record findings | **NOT STARTED — see G12** |
| 8.2 | Trademark review for Spot, UR, KUKA branded models | **NOT STARTED** |
| 8.3 | External security review of all four contracts | **NOT STARTED** |
| 8.4 | Move anchorer from a hot EOA to a multisig | **NOT STARTED — see G11** |
| 8.5 | Data-protection position: consent, erasure, salted commitments | **NOT STARTED** |
| 8.6 | Terms of use for contributors and buyers | **NOT STARTED** |
| 8.7 | Reproducibility harness: rebuild any episode's scene from its leaf | **NOT STARTED** |
| 8.8 | CI running contracts, protocol, log store and sample checks | **DONE** |

### Phase 9 — Real hardware

| # | Task | Status |
| --- | --- | --- |
| 9.1 | Real-robot capture client emitting the same leaf format (one embodiment) | **NOT STARTED** |
| 9.2 | Calibration and attestation for a capture rig | **NOT STARTED** |
| 9.3 | Band integration — contact channels into the sensor manifest | **NOT STARTED** |
| 9.4 | Biomechanics validation before any measured-force claim | **NOT STARTED** |
| 9.5 | First paid Contact Audit on a named failing task | **NOT STARTED** |

### Phase 10 — Multi-chain and go-to-market

| # | Task | Status |
| --- | --- | --- |
| 10.1 | `thenar-avax` synced — same sources, same 72 tests passing | **DONE** |
| 10.2 | Deploy to Avalanche Fuji, or amend `protocol.html` | **NOT STARTED — see G7** |
| 10.3 | Publish 3–5 reference tasks to standard | **NOT STARTED** |
| 10.4 | Seed 500+ episodes on one task to prove the loop at size | **NOT STARTED** |
| 10.5 | Ten named targets with a published manipulation failure | **NOT STARTED** |
| 10.6 | Pricing: simulated versus real, per episode, published | **NOT STARTED** |

---

## 4. Gap audit — after the execution pass

### Closed

- **G1 — episodes could not be verified on chain.** `GraspLog.verifyClip`
  hardcoded the 154-byte capture leaf. Closed by `LeafVerifier`, a stateless
  contract that reads the log's anchors and dispatches on the leaf's own
  version byte. Deployed, verified, and proven: `/verify` answers *"in the log
  — the contract confirms this episode"* for a real 197-byte leaf.
- **G2 — `/verify` hardcoded 154 bytes.** Now accepts both lengths, checks the
  version byte agrees with the length, and names the actual length when it does
  not.
- **G3 — `sample-task.json` 404'd.** Site redeployed; that file, a fresh
  capture sample and an episode sample are all live and all verify.
- **G6 — `thenar-avax` six files behind.** Synced: contracts, protocol, log
  service, docs, CI. 72 tests pass there too.
- **G8 — no CI.** `.github/workflows/ci.yml` runs contracts, protocol, log
  store, and checks the published samples against the live chain.
- **G9 — scripts skipped suites.** `pnpm test` now runs everything; addresses
  come from `.env.contracts`, and a new `selectors.ts` test asserts the
  hand-written selectors and addresses in the web pages match the deployment.
- **G10 — two markets.** `FoundryMarket` is canonical and documented as such.
- **G13 — no log service.** Built: `services/log`, persisted with
  `node:sqlite`, owning one append-only tree. This was the root cause of the
  incoherent anchors, and the store's API makes that incoherence inexpressible —
  the anchored size is always the log's true size.
- **G14 — dead files.** `gl.js` and `vtest.mjs` removed.

### Still open

- **G4 — no real trajectory has ever been recorded.** Unchanged and the most
  important one. Episodes carry real leaves, real seeds and real provenance,
  but their payload hashes are synthetic and quality scores are assigned rather
  than measured. Blocked on Phase 2 and 3: there is no simulator to record from.
- **G5 — the web app does not surface the foundry.** `/verify` reads the log
  and the verifier; there is still no task browser, corpus catalogue, curator
  dashboard or capture loop. Blocks Phases 2, 3, 5, 6.
- **G7 — `protocol.html` argues Avalanche; the deployment is Monad.** Not
  fixed: deploying to Fuji needs AVAX this wallet does not hold, and rewriting
  the page is a product decision rather than a bug fix.
- **G11 — the anchorer is a single hot EOA.** One key still controls the head,
  and is also deployer, curator and treasury in every script. Needs a multisig
  before production.
- **G12 — the 58 licences are from research, not from reading files.**
  Menagerie is still not vendored, so there is nothing local to audit.
- **G15 — no LeRobot v3 or RLDS export.** Blocks any sale.

### Found during execution, and fixed

- **`anchorHead` trusted its own record.** A store restored from an older copy
  would submit a size the contract refuses. It now reads the chain's head and
  fails loudly if the store is behind.
- **The verify page's selector was wrong** — the third hand-written selector I
  got wrong in this project. `packages/protocol/test/selectors.ts` now derives
  every selector and address and fails the build on drift.
- **`auditAnchors` read `a.index` where the store returns `a.idx`**, so the
  audit crashed rather than reporting.

## 5. The five that gate everything

1. **2.3 MuJoCo WASM + VFS** — no browser physics, no builder, no capture.
2. **2.5 Range authoring by dragging** — without it curators publish fixed
   scenes and the corpus is worthless.
3. **5.1 LeRobot v3 export** — otherwise the buyer writes an adapter and most
   will not.
4. **9.1 Real-hardware capture** — until this exists there is no product anyone
   pays the real number for.
5. **G12 per-model licence audit** — cheap, and it gates commercial ship.

*(Episode verification on chain was third on this list and is now closed.)*

## 6. Suggested order for the next working session

Everything from the previous list is done. What is left, in order:

1. **2.1 → 2.3** — vendor Menagerie, build the asset pipeline, get MuJoCo WASM
   stepping a scene in a browser tab. Everything in Phases 2, 3 and 9 waits on
   this, and it is the only way to close G4.
2. **G12** — read all 58 LICENSE files while vendoring, and record the result.
   It falls out of 2.1 almost for free.
3. **2.4 → 2.11** — the builder itself.
4. **5.1** — LeRobot v3 export, which can be written against the log store
   before the simulator exists.
