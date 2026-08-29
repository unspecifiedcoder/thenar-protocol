# THENAR — build plan

A builder agent should be able to pick any single task below and execute it
without further context. Every task carries a status; every gap names the task
it blocks.

**Audited:** 2026-08-29, against the working tree, not the README.

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
| `GraspLog` | `0x10325941C86397a4355b4801dC28EDf6c41F3c6f` |
| `GraspMarket` | `0x0f87309F410BDBB13B3E0d5c206e7aAC1397fBFa` |
| `TaskRegistry` | `0x70244c42300f427a721a86416331d2a8d6ce2a51` |
| `FoundryMarket` | `0x754845ff489f16a4a216562f0029aea29c678bad` |

Live chain state: 4 anchors, 1 task, 1 corpus, 1 licence receipt.
Test suites: 60 Solidity tests, 26 TypeScript checks, all passing.
Live site: https://thenar.io with `/verify` reading the contract directly.

**The honest summary:** the *settlement and provenance layer is real and
proven*. The *product that produces data does not exist yet* — there is no
builder, no simulator, no capture loop, and no real trajectory has ever been
recorded. The foundry end-to-end proves the economics and the plumbing using
synthetic leaf hashes, not demonstrations.

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
| **1.8** | **Wire `EpisodeLeaf` into `GraspLog` so episodes can be verified** | **BLOCKED — see G1** |
| 1.9 | Redeploy `GraspLog` (or add `GraspLogV2`) accepting both leaf versions | **NOT STARTED** |
| 1.10 | Decide and document which market is canonical; retire the other | **NOT STARTED** |

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
| 4.1 | Off-chain log service maintaining the CT tree (append, root, proofs) | **NOT STARTED** |
| 4.2 | Persistent store for leaves and episode payloads | **NOT STARTED** |
| 4.3 | Hourly anchor job → `GraspLog.anchor` | **NOT STARTED** |
| 4.4 | Inclusion / consistency proof API | **NOT STARTED** |
| 4.5 | Acceptance pipeline: score, threshold on `minScoreBps`, accept or reject | **NOT STARTED** |
| 4.6 | Duplicate and replay detection (jittered resubmission must be caught) | **NOT STARTED** |
| 4.7 | Consent withdrawal endpoint → sparse tree → anchored | **NOT STARTED** |
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
| 7.3 | Extend `/verify` to 197-byte episode leaves | **BLOCKED by 1.8 — see G2** |
| 7.4 | Consent-status check in `/verify` (`verifyConsentLive`) | **NOT STARTED** |
| 7.5 | Append-only check in `/verify` (`verifyAppendOnly`) | **NOT STARTED** |
| 7.6 | Scene rebuild in `/verify` — show the world from spec + seed | **NOT STARTED** |
| 7.7 | Deploy `sample-task.json` to the live site | **NOT STARTED — see G3** |

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
| 8.8 | CI running all suites on push | **NOT STARTED — see G8** |

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
| 10.1 | Sync `thenar-avax` with the foundry layer | **NOT STARTED — see G6** |
| 10.2 | Deploy to Avalanche Fuji, or amend `protocol.html` | **NOT STARTED — see G7** |
| 10.3 | Publish 3–5 reference tasks to standard | **NOT STARTED** |
| 10.4 | Seed 500+ episodes on one task to prove the loop at size | **NOT STARTED** |
| 10.5 | Ten named targets with a published manipulation failure | **NOT STARTED** |
| 10.6 | Pricing: simulated versus real, per episode, published | **NOT STARTED** |

---

## 4. Gap audit

Greps for `mock`, `stub`, `TODO`, `FIXME`, `fake`, `dummy`, `placeholder`,
`not implemented`, `hardcoded` across all shipped `.ts`, `.sol`, `.mjs`, `.js`,
`.html`, `.json` returned **no gaps in shipped code**. Every hit was a
legitimate test double (`MockUSD` in `GraspMarket.t.sol`), a negative-test
variable named `fake`, an HTML `placeholder=` attribute, or marketing copy.

The real gaps are architectural, and greps do not find them.

### G1 — `EpisodeLeaf` is orphaned; no episode can be verified on chain
**Severity: critical. Blocks 1.8, 7.3, and the core auditability claim.**
`GraspLog.verifyClip` hardcodes `ClipLeaf.hashPreimage`, which requires version
`0x01` and exactly 154 bytes. `EpisodeLeaf` is version `0x02` and 197 bytes, so
verification reverts `UnsupportedVersion`. `EpisodeLeaf` is referenced by no
deployed contract — only by its own file and its tests. The claim that an
episode is auditable via its `worldSeed` has **no on-chain verification path
today**. Requires a redeploy.

### G2 — `/verify` cannot accept an episode leaf
**Severity: high. Blocks 7.3.** `verify.html` hardcodes `if (bytes !== 154)`
at line 264 and says "154-byte preimage" in the copy. Downstream of G1.

### G3 — `sample-task.json` is in the repo but 404s on the live site
**Severity: medium. Blocks 7.7.** The site was deployed before the foundry
end-to-end wrote the file. `/sample-proof.json` returns 200; `/sample-task.json`
returns 404. Fix by redeploying `apps/web`.

### G4 — No real trajectory has ever been recorded
**Severity: critical (honesty). Blocks Phases 3–5.** In
`scripts/foundry-e2e.mjs` the "episodes" are `keccak256("episode:…")` hashes and
the quality scores are hand-chosen constants (9100 / 7400 / 6200). The run
proves the economics, provenance and settlement plumbing. It does **not** prove
any demonstration data exists. No trajectory recorder, no scorer, no simulator.

### G5 — The web app does not surface the foundry at all
**Severity: high. Blocks Phases 2, 3, 5, 6.** `grasp-chain.js` points at
`GraspLog` and the **old** `GraspMarket`, not `TaskRegistry` or `FoundryMarket`.
`TaskSpec`, the sampler and the embodiment registry are used by no page. The
addresses appear only inside `sample-task.json`.

### G6 — `thenar-avax` is six files behind
**Severity: medium. Blocks 10.1.** Missing `TaskRegistry.sol`,
`FoundryMarket.sol`, `EpisodeLeaf.sol`, `taskspec.ts`, `embodiments.ts` and
`docs/ROADMAP.md`. It carries only the Phase 0 protocol layer.

### G7 — `protocol.html` argues Avalanche; the deployment is Monad
**Severity: medium. Blocks 10.2.** The public protocol page makes a specific
C-Chain argument on USDC depth. Nothing is deployed on Fuji. A reviewer reading
the page and then the README finds the mismatch immediately.

### G8 — No CI
**Severity: medium. Blocks 8.8.** 86 tests exist and nothing runs them on push.
No `.github` directory.

### G9 — `package.json` scripts do not cover the current suites
**Severity: low.** `test:protocol` runs only `run.ts`, never `foundry.ts`.
There is no script for `foundry-e2e.mjs`, and `deploy:monad` runs only
`Deploy.s.sol`, never `DeployFoundry.s.sol`. A contributor running
`pnpm test:protocol` silently skips 13 checks.

### G10 — Two markets coexist with overlapping purpose
**Severity: medium. Blocks 1.10.** `GraspMarket` (corpus-root purchase) and
`FoundryMarket` (task-bound corpus with curator split) are both deployed and
both referenced in the README. Nothing states which is canonical.

### G11 — The anchorer is a single hot EOA
**Severity: high for production. Blocks 8.4.** One key
(`0xDf93bdA9…`) controls the head of the log. Its compromise means forged
anchors. It is also the deployer, the curator and the treasury in every script.

### G12 — The 58 licences are from research, not from reading files
**Severity: high for commercial ship. Blocks 8.1.** `embodiments.ts` records a
licence per model, sourced from the Menagerie repository listing rather than
from reading each model directory's LICENSE. Correct so far as observed, but
not audited. Menagerie is not vendored, so there is nothing local to check.

### G13 — No off-chain log service exists
**Severity: high. Blocks Phase 4.** The CT tree is rebuilt in memory inside
scripts. There is no service that appends leaves, persists the tree, serves
proofs, or anchors on a schedule. Anchors have only ever been made by hand.

### G14 — Dead and scratch files
**Severity: low.** `apps/web/gl.js` is referenced by no page.
`scripts/vtest.mjs` is a debugging script written to probe the verify-page
encoder and has no ongoing purpose.

### G15 — No LeRobot v3 or RLDS export
**Severity: high. Blocks 5.1, 5.2, and any sale.** The format buyers expect
does not exist in the codebase in any form.

---

## 5. The five that gate everything

1. **2.3 MuJoCo WASM + VFS** — no browser physics, no builder, no capture.
2. **2.5 Range authoring by dragging** — without it curators publish fixed
   scenes and the corpus is worthless.
3. **1.8 / G1 Episode verification on chain** — the auditability claim is
   currently unbacked.
4. **5.1 LeRobot v3 export** — otherwise the buyer writes an adapter and most
   will not.
5. **9.1 Real-hardware capture** — until this exists there is no product anyone
   pays the real number for.

## 6. Suggested order for the next working session

1. **1.8 + 1.9** — fix G1. Small, and it un-blocks the verification story.
2. **G3, G9, G14** — redeploy the site, fix the scripts, delete the scratch. An
   hour, and it removes three embarrassments.
3. **8.8 CI** — cheap, and stops the suites rotting.
4. **2.1 → 2.3** — vendor Menagerie and get MuJoCo WASM stepping a scene in a
   tab. This is the real work and everything waits on it.
