# THENAR — company thesis, market analysis, hostile review, product strategy

Written 2026-09-03 against the working tree at commit `11facc8`, not against
the README. Every claim about the repository was checked by reading the code
and running the suites (`forge test`: 72 passed). Every claim about the market
carries a source in §2.7.

This document holds artifacts 1–5 and 12 of the requested output. `PLAN.md`
holds the architecture as a source of truth for implementation; `TASKS/` holds
the atomic tasks; model allocation is in `PLAN.md §25` and on every task.

---

## 1. COMPANY THESIS

### 1.1 What THENAR actually does today

Strip the site copy away and the repository is four things:

1. **A Certificate-Transparency-style log for capture records.** An off-chain
   RFC 6962 Merkle tree (`packages/protocol/src/log.ts`, persisted by
   `services/log/src/store.ts` in SQLite) whose head — root, size, and a
   sparse-Merkle root of revoked consents — is anchored on an EVM chain by
   `GraspLog.sol`. The contract enforces a monotonic head (size must grow,
   root must change) and verifies inclusion, consistency (append-only),
   consent non-membership, and *revocation onset* (present at anchor *i*,
   absent at *i−1*). The Solidity and TypeScript implementations are held to
   each other by generated vectors (`Vectors.sol`).
2. **Two fixed-width leaf formats** that commit to a record without carrying
   identity, payload or free text: `ClipLeaf` (154 B) and `EpisodeLeaf`
   (197 B, adds `taskId`, `worldSeed`, `successFlag`, `qualityScore`). The
   consent commitment is re-salted per submission so leaves are unlinkable.
3. **A licensing/settlement layer.** `TaskRegistry` (task = hash of a canonical
   spec + curator share ≤ 30%), `FoundryMarket` (seal a corpus against an
   anchored root with a frozen quality-weighted cap table; `license()` pays
   curator, contributors and protocol in one call, crediting refusers rather
   than reverting), and the superseded `GraspMarket`.
4. **A task-as-distribution spec.** `TaskSpec` with a validator that refuses
   a task with no variation, a hash-stream sampler that rebuilds a scene from
   `(taskId, seed)` on any machine, and a registry of 58 permissively-licensed
   MuJoCo Menagerie embodiments.

Around that: a static site whose `/verify` and `/corpus` pages read the chain
directly; a LeRobot-v3-*shaped* exporter that writes JSONL with `null`
observation columns; a Vercel join form; CAD for a wrist sensor ("Band") nobody
has worn; a desk robot ("Hotaru") unrelated to the data business.

**Deployment state.** The contracts are deployed and verified on Monad
testnet; the Avalanche Fuji addresses are the zero address. The site, the
export metadata and `grasp-chain.js` still say Monad in places. **No real
trajectory has ever been recorded**; every episode in the log has a synthetic
payload hash and an assigned quality score. Revenue, contributors, buyers,
devices worn: zero. The company page says so, which is to its credit.

### 1.2 What problem it is solving, as currently framed

The current framing is three stacked bets: (a) contact/grip-force data is the
missing modality for manipulation; (b) a wearable (the Band) will capture it;
(c) a browser "foundry" where curators design simulated tasks and contributors
drive them will bootstrap supply; with GRASP as the settlement rail underneath.

(a) is a genuine and now well-documented gap (§2.2). (b) is a hardware company
competing against Tacta Systems ($75M, 256 tactile sensors per fingertip,
factory deployments in early 2027) with a CAD file. (c) produces simulated
data that the market pays a fraction for, driven by a mouse, which the
repository's own `docs/EMBODIMENTS.md` concedes "is the fastest way to produce
a corpus nobody buys." The thing that is actually built and works — the
log — is presented as "the settlement half" of a data business that does not
exist.

**Verdict:** the current *concept* is weak; the current *asset* is not. The
asset is misfiled under the wrong company.

### 1.3 Strongest technical assets

| Asset | Why it matters |
| --- | --- |
| Monotonic-head CT log with SMT revocation and proven onset | This is the correct construction for "prove the record existed, was not reordered, and consent had not been withdrawn as of block *N*." Most "data provenance on chain" projects publish bags of roots, which prove nothing about ordering or absence. |
| Cross-implementation vectors | The TS reference generates the Solidity vectors; a passing suite means both agree on every hash. Cheap to build, rare in practice, and exactly what a diligence reviewer asks for. |
| Fixed-width, identity-free leaves with re-salted consent | The privacy position is right: nothing on chain is ever an identifier, so erasure requests are satisfiable. |
| Receipt binds `(buyer, termsHash, corpusRoot, amount)` in one transaction | The one place a chain is clearly better than a database: neither side can later dispute which terms covered which bytes. |
| Deterministic `(taskId, seed) → scene` sampler | A reproducible-world primitive. Not central to the new thesis, but reusable for simulation-provenance products later. |
| Honest limitation statements | "Anchoring proves a record existed… not that the record is true." Keep this discipline; it becomes the product's claim ladder (§4.4). |

### 1.4 Novel vs. good engineering vs. copyable

- **Genuinely novel (as a combination):** consent-revocation as SMT
  non-membership *inside* a CT log head, with an on-chain onset proof, wired
  to a licence receipt that names the anchored root. I know of no shipped
  system for training data doing this.
- **Good engineering, not novel:** RFC 6962 verification, SMT with H(0,0)=0,
  the market contracts, the leaf encodings, the sampler.
- **Easy to copy:** the whole repository. ~3k lines of protocol/contract code;
  a strong team reproduces it in two weeks. There is no data, no device, no
  customer, no integration. Nothing here is a moat today (§7 explains what
  would be).
- **Hard to copy, if built:** a neutral log that multiple suppliers already
  write to and multiple buyers' counsel already ask for; device attestation
  chains negotiated with headset/robot OEMs; a verification track record.

### 1.5 Assumptions the current architecture makes

1. **One honest anchorer.** A single EOA anchors whatever tree it likes. The
   chain prevents *equivocation* (one canonical head) but not *omission*
   (refusing to log a leaf) or *fabrication* (logging invented leaves). This
   is the same trust model as a single CT log operator — acceptable if stated,
   and only acceptable with a multisig and mirrors.
2. **The steward is honest about cap tables.** `sealCorpus` weights are
   whatever the steward submits. "Quality-weighted split" is Thenar's word.
3. **Revocation is unauthenticated.** `LogStore.revoke()` takes any key. No
   signature proves the revoker owns the consent. A hostile operator could
   revoke a competitor's corpus; a contributor cannot prove they revoked.
4. **`payloadHash` is undefined.** "keccak256 of the episode bytes" — which
   bytes? Parquet? MP4? A zip? Different serialisations of the same episode
   give different hashes, so the commitment is not reproducible by a buyer.
   Same for `manifestHash` — there is no manifest schema.
5. **Corpus root == log root.** `sealCorpus` requires `corpusRoot == anchor.root`
   and `corpusSize == anchor.size`, so a "corpus" is *the entire log prefix*,
   regardless of `taskId`. Two tasks cannot have two corpora at one anchor;
   buying corpus *k* licenses every leaf ever logged. This is a design error,
   not a bug.
6. **Contributors have EVM addresses**, contradicted by the protocol page
   ("paid on ordinary rails").
7. **The chain is reachable and final.** Fine.

### 1.6 What the system actually guarantees

Given the assumptions above, and only then:

- **G1 Integrity.** A leaf proven at anchor *i* was in the tree the anchorer
  published at *i*; any anchor *j > i* extends it or a consistency proof fails.
- **G2 Absence.** A consent key proven absent at anchor *i* had not been
  revoked *as known to the anchorer* at *i*.
- **G3 Onset.** A revocation's first public appearance is provably block *b*.
- **G4 Receipt.** A buyer paid *X* under terms hash *T* for the tree at anchor
  *i*, and this cannot be rewritten.

What it does **not** guarantee, and where the copy is stronger than the code:

- "A buyer verifies a slice without trusting us" — inclusion yes; but *which*
  leaves make up a corpus is Thenar's word (assumption 5), and the bytes that
  hash to `payloadHash` are unspecified (assumption 4).
- "Contributor can withdraw provably" — they can if Thenar records it
  (assumption 3). The proof is of Thenar's action, not the contributor's.
- "Quality-weighted payment" — the weights are unverifiable (assumption 2).
- Anything about physical truth. The README says this; the landing page's
  "contact data for physical AI" implies otherwise.

**The line that must never blur:** a commitment proves *these bytes, at this
time, under these terms, still consented*. It never proves *a hand squeezed a
glass with 4.2 N*. The entire strategy below is built on keeping that
distinction explicit and selling a ladder of increasingly strong claims rather
than pretending the bottom rung is the top.

---

## 2. COMPETITIVE / MARKET ANALYSIS

### 2.1 The ecosystem in September 2026

**Demand side.** Robot foundation models are trained the way LLMs were in
2022: pretrain on everything open (Open X-Embodiment: >1M trajectories, 22
embodiments; LeRobot: 16k+ datasets), then fine-tune on 5–20k *net-new,
commercially licensed* episodes on the target embodiment. The fleets that
matter (Figure, Agility, Tesla, Physical Intelligence, AgiBot, TRI) run their
own data engines. Everybody else buys.

**Supply side has been funded in the last 18 months:** XDOF ($70M; released
ABC-130K, 130,919 bimanual episodes, ~3,600 h), Config ($35M, bimanual),
Mecka (~$68M, body-sensor human motion), Tacta Systems ($75M, sensorised
gloves on production lines), Micro1 (gig workers in 50+ countries, >160,000 h
of video/month), Encord ($110M, annotation infra), AgiBot World 2026 (tactile
+ contact, single synchronised pipeline), plus Truelabel as a matching layer.
Teleoperation on a target robot prices at $50–200/hour; the "teleoperation
data infrastructure" market is estimated at $320M (2025) → $420M (2026) →
$4.3B (2034).

**Crypto-adjacent:** PrismaX ($11M, a16z CSX; token-incentivised physical
interaction data), BitRobot/FrodoBots ($8M; 2,000 h of sidewalk teleop),
GEODNET, XMAQUINA. All of them are *supply* plays: pay tokens for data. None
is a neutral rights/provenance layer.

**Standards and regulation:** LeRobotDataset v3 is the de-facto format;
ISO/WD 26264-1 is the first draft standard for humanoid datasets; C2PA
hardware signing shipped in Pixel 10 and eight Sony cameras; the EU AI Act
GPAI obligations (training-content summary, copyright policy) took effect
2025-08-02 with full AI Office enforcement from **2026-08-02** — last month —
and Article 10 requires documented data provenance for high-risk systems,
which industrial robots are.

### 2.2 The actual bottlenecks (not "lack of a blockchain marketplace")

1. **What to record, not how much.** Force/tactile/contact are missing from
   most corpora; the ones that have them rarely synchronise touch and force
   onto the video timeline. This is a *sensor and pipeline* problem and
   funded companies are attacking it. Thenar cannot win it with a CAD file.
2. **Rights.** 10–20% of Hugging Face robotics datasets ship without any
   licence file. An enterprise programme of 5–10 datasets costs 40–160 hours
   of licence audit plus NOTICE files, indemnification riders and
   contributor-consent verification. Human-worn capture (gloves, headsets,
   phones in homes) drags in GDPR: consent scope, erasure, and the unsolved
   question of what a withdrawal means for a model already trained.
3. **Authenticity and fraud at scale.** When suppliers pay per episode and
   gig workers submit 160k hours a month, duplicates, jittered replays,
   simulation-passed-as-real and stitched clips become a cost centre. Today
   this is solved by each supplier's internal QA, which the buyer cannot
   inspect.
4. **Lineage.** "Which episodes trained this checkpoint, under which licences,
   and were any of them withdrawn since?" is now a regulatory question with
   an enforcement date, and nobody has an answer better than a spreadsheet.
5. **Cross-organisation pooling doesn't happen.** Fleet operators hoard
   because there is no way to share without losing control. OXE worked because
   academics don't sell.

The question "what infrastructure becomes necessary when millions of robots
generate valuable experience?" has a specific answer: **a neutral log of who
captured what, on which device, under which rights, still consented, and
which models it went into** — the Certificate Transparency of machine
experience. Nobody *wants* to buy CT. Every CA writes to it because the
relying parties require it. The relying parties here are buyers' counsel,
regulators, insurers and, eventually, the model consumers themselves.

That is the infrastructure THENAR's assets are actually shaped for.

### 2.3 Ten directions, scored

Scores 1–5. *WTP* = willingness to pay; *T₁* = time to first revenue; *P100* /
*P1B* = subjective probability of $100M revenue / $1B outcome.

| # | Direction | Customer | Pain | Chain needed? | Defensibility | Network effect | WTP | T₁ | P100 | P1B |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | Contact-data capture company (Band + Contact Audit) — *the current plan* | Labs with slip/crush failures | 4 | No | 1 (Tacta has $75M and shipping hardware) | 1 | 3 | 12 mo+ | 5% | <1% |
| B | Browser simulation foundry (MuJoCo WASM, curators, mouse-driven contributors) | Nobody identified | 1 | No | 1 | 2 | 1 | never | 1% | <1% |
| C | Two-sided robot-data marketplace | Buyers, suppliers | 2 | Weak | 1 (liquidity, Truelabel exists) | 3 if liquid | 2 | 9 mo | 10% | 3% |
| **D** | **Provenance & rights ledger for physical-AI data ("CT for robot data")** | Suppliers who need to sell to enterprise; buyers' counsel | 4 | Minimal but real (neutral timestamp, anti-equivocation, receipt) | 3→5 with adoption (neutrality + standard) | 4 (relying-party effect) | 3 | 3 mo | 30% | 10% |
| E | Robot/device identity & attestation PKI | OEMs, fleets | 3 now, 5 later | No | 4 (OEM integrations) | 4 | 3 | 18 mo | 20% | 10% |
| F | Training-set lineage & AI-Act audit (model ↔ dataset receipts) | Model builders' compliance | 4 (post Aug 2026) | Weak | 2 (generalist governance vendors) | 3 | 4 | 6 mo | 20% | 5% |
| G | Data clean-room for cross-fleet pooling (compute-to-data with lineage) | Fleet operators | 3 now, 5 later | Weak | 4 | 5 | 4 | 24 mo+ | 15% | 15% |
| H | Contributor consent & compensation rails for human-worn capture | Glove/headset/gig suppliers | 4 | Only cross-org | 2 | 2 | 3 | 6 mo | 10% | 2% |
| I | Data-quality certification ("UL for robot data": dedup, replay, sim-vs-real, plausibility) | Buyers pre-purchase; suppliers pre-sale | 4 | No | 3 (track record, adversarial know-how) | 3 | 4 | 3 mo | 20% | 3% |
| J | Machine-to-machine experience exchange (robots buying skills) | Future | 1 | Yes | ? | 5 | 0 | 5 yr | 5% | 5% |

**Ranking:** D > (D+I) > E > G > F > H > C > A > B > J.

**Why D wins.** It is the only direction where (i) the code that exists is the
core rather than the decoration, (ii) the pain is documented, growing and
legally dated, (iii) neutrality — which a capture company can never have — is
the moat, (iv) the chain does a small, honest job instead of a pretextual one,
and (v) E, F, G and I are *layers on D* rather than alternatives: I is the
wedge (§5), E is the trust ladder's upper rungs (§8), F is a leaf type, G is
the five-year product. A and B are discarded as company theses; the Band is
kept only as a possible reference L2 device years from now, and the simulation
foundry is shelved.

### 2.4 Chain-agnostic view, and where Avalanche fits

The protocol must be chain-agnostic and is nearly so today: plain EVM, no
precompiles, no chain id inside any leaf. The honest position:

- **The chain's job is small:** one canonical, neutral, censorship-resistant
  head for the log; a non-repudiable timestamp; a receipt that binds payment
  to terms and root. Cost at hourly cadence: pennies a day on any chain.
- **Avalanche C-Chain is a good primary** for the next 12–24 months: native
  USDC and a real payments push (Avalanche Payments Collective, 28 orgs;
  $84B stablecoin transfer volume), sub-second finality, EVM tooling, and the
  institutional narrative buyers' finance teams find legible (Progmat's $2B
  tokenised-asset migration, Tassat's Lynq). It is a *good* choice, not a
  *necessary* one; say so.
- **Mirror anchors** to a second chain (Ethereum L1 or an L2 such as Base) at
  a daily cadence make the log verifiable if any one chain or its RPCs
  disappear, and remove the "you picked a chain to farm a grant" objection.
- **An Avalanche L1 is the one Avalanche-specific advantage** worth keeping in
  reserve: if a consortium of OEMs and data suppliers ever wants to *run the
  log's validator set themselves* (a CT-style multi-operator log with a
  permissioned validator set and USDC settlement on the C-Chain), Avalanche's
  L1 model fits exactly. That is a year-3 decision. Do not build it now.

---

## 3. HOSTILE INVESTOR ANALYSIS

Framing: a $10M seed for "THENAR: the provenance and rights ledger for
physical-AI training data." I am trying to reject it.

| Objection (strongest form) | Fatal? | Strongest counter | Evidence that would settle it |
| --- | --- | --- | --- |
| **Nobody needs this.** Labs with fleets own their data end to end; provenance is a spreadsheet. | Not fatal, but true for the in-house case. | The growing segment is *licensed* data: 5–20k episodes bought from XDOF/Micro1/Mecka-type suppliers. Every such purchase now needs a rights record, and 40–160 h of counsel time per programme says the spreadsheet is failing. | Count of paid third-party data deals in 2026; hours of legal review per deal; whether 3 suppliers will pre-log to close deals faster. |
| **Robotics companies will build it internally.** | Not fatal. | A supplier's own provenance system is a supplier's word. Relying parties want a log the supplier does not control — the same reason no CA is trusted to run the only CT log for its own certs. Neutrality is the product, and a capture company structurally cannot offer it. This is also why THENAR must *stop* trying to be a capture company. | Whether buyers' counsel accept a supplier-run log; whether any supplier says "we'd rather a third party held this." |
| **Blockchain provides no meaningful value.** | Mostly true, not fatal. | Correct — it is ~5% of the system and must not be the pitch. What it provides: a canonical head no party (including THENAR) can fork; a timestamp nobody administers; a payment-terms-root binding that neither side can revise. Total cost ≈ $100/year. If a court or regulator would accept a THENAR-run database as equally neutral, drop it. They won't, yet. | A buyer's counsel opinion letter on whether an anchored log changes their diligence burden. |
| **Avalanche provides no meaningful value.** | Not fatal. | Also nearly correct. It provides USDC-native settlement and cheap finality; every other EVM chain provides most of that. The architecture is chain-agnostic and mirrors anchors elsewhere. The L1 path is the only unique asset and is deliberately unused. | Whether any buyer pays in USDC on-chain at all in year 1. If none do, settlement should move to fiat rails and the chain is anchoring only. |
| **The data cannot be trusted.** A hash proves nothing about a hand or a robot. | **Fatal to the old thesis; the pivot exists because of it.** | The product sells a *claim ladder*: L0 integrity → L1 signed at capture → L2 hardware-attested device → L3 statistically verified → L4 reputation. Each rung states exactly what it proves. Buyers already accept L3-style QA from suppliers they cannot inspect; THENAR makes it inspectable. | Whether buyers pay more for L2/L3-labelled episodes than L0. Price delta is the whole thesis. |
| **Provenance is not the real bottleneck; capture is.** | Half true. | Capture is the bigger market and is being funded; THENAR should not compete in it. Provenance is the smaller market that *every* capture dollar must pass through once buyers demand it — a toll booth, not a mine. Toll booths are smaller and more durable. | Ratio of licensed-data spend to provenance spend over time; whether the ratio holds at ~3–5%. |
| **Nobody will pay.** | Not fatal; year-1 revenue will be small. | Three payers: suppliers (SaaS + per-episode logging, to close enterprise deals), buyers (verification reports pre-purchase, $5–25k), and settlement take (2.5%). Year-1 is consulting-shaped revenue; the log fills as a by-product. | Three paid reports in 6 months. If not, the wedge is wrong. |
| **Too early.** | Partially. | AI Office enforcement started 2026-08-02; C2PA hardware shipped; suppliers raised $300M+ in 12 months and need to sell to enterprise. "Early" was 2024. | Regulatory actions against a model builder over training-data documentation in 2026–27. |
| **XDOF/Encord copies it in a quarter.** | Not fatal. | They can copy the code; they cannot become neutral. Encord is the most dangerous (it is already infra, not capture); the defence is to be the log *Encord writes to*, i.e. open protocol, multiple operators, standards posture. | Whether Encord or HF ship a competing provenance log; whether they would integrate ours. |
| **Marketplace liquidity.** | N/A. | Not a marketplace. The repositioning removes this objection entirely. | — |
| **Contributors won't generate enough data.** | N/A. | THENAR does not generate data. Suppliers do. | — |
| **Unnecessary protocol complexity.** | Real risk. | The protocol surface is small: four leaf types, one log contract, one licence contract, one verifier. Everything else is off-chain and conventional. Complexity budget is enforced by invariants (PLAN §5). | Lines of Solidity stay under ~1,200; a new engineer verifies a proof from the spec in a day. |
| **Regulation kills it.** | Reverse. | Regulation is the demand driver. The risk is non-enforcement, which slows but does not kill: counsel and insurers ask for provenance regardless. | Enforcement cadence. |
| **The economics don't work.** | Not fatal, but $1B requires expansion. | Provenance alone caps near the toll-booth ceiling (~$30–50M at 2030 volumes). The $1B case needs the upper layers: verification (I), attestation (E) and the clean-room (G) where the log becomes the rights engine for pooled fleet data. That is a 5-year path and it is stated as such. | Verification and attestation revenue exceeding logging revenue by year 3. |
| **No network effect.** | Weak early, real later. | Relying-party effect: once N buyers' counsel ask for a THENAR report, every supplier logs; once M suppliers log, buyers default to asking. Standards effect if the leaf/manifest format is adopted (ISO 26264 engagement). | Unprompted inbound from suppliers after buyer requests. |

**Verdict:** the thesis survives, *conditional on three things the company
must do rather than say*: (1) stop being a capture/hardware company; (2) put
the chain in a footnote; (3) sell the claim ladder honestly, never letting L0
be read as L3. If the founders cannot let go of the Band as a product, do not
fund.

---

## 4. PRODUCT STRATEGY

### 4.1 Category

**Physical-AI data provenance** — the transparency log and rights ledger for
machine experience. One line: *"THENAR proves what a robot dataset is, where
it came from, who may train on it, and whether that is still true."*

### 4.2 Roles and value exchange

| Role | Who | Pays / is paid |
| --- | --- | --- |
| **Supplier** (supply) | Capture companies, gig-data platforms, academic labs, fleet operators releasing data | Pays SaaS + per-episode logging; is paid licence revenue through the settlement contract |
| **Buyer** (demand) | Robotics companies fine-tuning; their counsel | Pays for verification reports and licences |
| **Contributor** | Teleoperators, glove wearers, households | Is paid by the supplier; holds a consent key and can revoke with proof |
| **Verifier** | THENAR first; third parties later | Is paid per verification claim |
| **Relying party** | Regulators, insurers, auditors | Reads; does not pay; creates demand |
| **THENAR** | Log operator, verifier #1, protocol steward | SaaS, reports, 2.5% settlement, verification fees |

The protocol coordinates: *what was committed, by whom, under which terms,
still consented, verified to which level, licensed to whom, paid how much*.

### 4.3 Three wedges

**W1 — Provenance Report on a corpus about to change hands.** A buyer (or a
supplier trying to close) sends THENAR a LeRobot v3 dataset. THENAR ingests
it, computes canonical episode commitments, runs L3 checks (duplicates,
jittered replays, timestamp/physics plausibility, sim-vs-real heuristics),
appends every episode and the corpus manifest to the log, anchors, and
delivers a counsel-readable report with proofs plus an on-chain corpus
receipt. First customer: any lab that has just been quoted 10k episodes by a
capture vendor. Adoption reason: it makes a $200k–$2M purchase defensible.
Acquisition: direct — the founders of the funded suppliers and the heads of
data at ~30 labs, by name. MVP: 8–10 weeks (ingest → commit → verify →
report). Revenue: $5–25k per report; weeks to first dollar. Strategic value:
real data enters the log immediately; every report is a reference; the L3
checks build the adversarial know-how that becomes the verification moat.
Moat created: track record + first datasets logged.

**W2 — Recorder SDK: sign at capture.** A `lerobot`-compatible recorder
plugin that generates a session key, signs each episode's manifest at
`episode_end`, and streams leaves to the log — with optional device
attestation (Android Key Attestation for Quest/phones, TPM quotes for
Jetson/NUC rigs). Sold to suppliers who want to be "pre-verified" so buyers
skip W1. MVP: 6 weeks after W1. Revenue: per-episode + SaaS. Strategic value:
this is where L1/L2 claims come from and where switching costs begin.

**W3 — Consent and revocation service for human-worn capture.** For suppliers
whose data comes from people (gloves, headsets, homes): consent records,
salted commitments, signed revocation, erasure trail with onset proofs,
GDPR-ready. MVP: 6 weeks. Narrower, but it is the only wedge that addresses an
existential legal exposure for the supplier.

**Choice: W1, with W2 following immediately and W3 as a W2 feature.**
W1 needs no network, no hardware, no contributors, and no simulator; it
produces revenue and real logged data in the same quarter; it retires G4
("no real trajectory ever recorded") by ingesting the thousands of real
LeRobot datasets that already exist; and it forces the two protocol fixes
that matter most (defined `payloadHash`; corpus ≠ log prefix). Everything the
old plan had on the critical path — MuJoCo WASM, range authoring, the
capture loop — leaves it.

### 4.4 The claim ladder (the product, stated precisely)

| Level | Claim | Mechanism | Who can produce it |
| --- | --- | --- | --- |
| **L0 Committed** | These bytes existed by block *b*; the log was not rewritten; consent had not been withdrawn as of anchor *i*. | Leaf in CT log; anchor; SMT non-membership. | Anyone via THENAR ingest. |
| **L1 Signed** | An identified organisation/session claims to have captured this, and the manifest has not changed since it was signed. | Ed25519 session key registered to an org; signature over the manifest hash with domain separation. | Suppliers using the SDK. |
| **L2 Attested** | The signing key lived in hardware a named manufacturer vouches for, on a device of a named model, running named firmware. | Android Key Attestation / Apple App Attest / TPM 2.0 quote chained to the manifest. | Suppliers on attestable hardware. |
| **L3 Verified** | A named verifier ran named checks and found: not a duplicate of any logged episode above threshold; timestamps monotonic at declared rate; joint states within embodiment limits; proprioception consistent with video motion; no simulation signature. | Signed VerificationClaim leaves referencing the episode leaf. | THENAR; later third parties. |
| **L4 Reputed** | This supplier/device's history of L3 outcomes and disputes. | Derived off-chain from claims; never a stable on-chain identifier. | Indexer. |

Every product surface — report, `/verify`, SDK output, API — labels each
episode with its level and never displays a higher level than the evidence
supports. This is PLAN invariant I-1.

### 4.5 The long-term company

- **Moat:** neutrality (structural — never own capture), the relying-party
  network (buyers' counsel ask by name), attestation integrations with
  headset and robot-compute OEMs (negotiated, slow, sticky), verification
  track record (adversarial know-how compounds), and dataset-lineage
  switching costs (once a model's training receipts point at our log, moving
  logs means re-proving history).
- **Network effect:** each supplier logging makes buyer requests more
  routine; each buyer request makes logging more necessary; each verified
  episode makes the dedup index (and therefore every future verification)
  better. The last one is the real, mechanical effect: *near-duplicate
  detection improves with the size of the corpus of logged episodes*, and
  only the neutral log sees everyone's episodes.
- **Flywheel, proven not assumed:** more suppliers → more logged episodes →
  a larger dedup/plausibility reference → cheaper, stronger L3 claims →
  buyers pay a premium for L3 → suppliers log to earn the premium. The
  premium is the measurable variable; if L3 episodes do not clear a price
  premium within 12 months of the first report, the flywheel does not exist
  and the company is a compliance vendor (still fundable, not $1B).

### 4.6 What is thrown away, shelved, kept

| | Item | Decision |
| --- | --- | --- |
| Throw away | `GraspMarket.sol` (superseded), Monad references, "Contact Audit" GTM, Hotaru as a company asset, "contact data for physical AI" as the tagline | Remove |
| Shelve | MuJoCo WASM builder, range-authoring UI, browser capture loop, contributor leaderboards, simulated corpora | Not on any critical path; keep `TaskSpec`/sampler as an optional metadata schema for simulation-provenance |
| Park | The Band | A possible L2 reference device in year 3; not a product; no validation study funded |
| Keep and fix | `GraspLog`, `LeafVerifier`, `MerkleLog`, `SparseMerkle`, `ClipLeaf`/`EpisodeLeaf`, `TaskRegistry`, `FoundryMarket` (restructured), log store, `/verify`, CI, vectors | Core |
| Build | Canonical manifests, defined payload hashing, corpus manifest leaf, verification claim leaf, signed revocation, HTTP log service, ingest, L3 verifiers, recorder SDK, attestation ingestion, provenance report, USDC settlement, mirror anchoring | PLAN §16 |

---

## 5. TARGET ARCHITECTURE (summary; normative detail is in PLAN.md)

```
 Supplier                    THENAR                                    Chain(s)
 ─────────                   ──────                                    ────────
 lerobot recorder ──SDK──▶ ingest ──▶ canonicaliser ──▶ leaves ──▶ CT log ──▶ anchorer ──▶ GraspLog (Avalanche C-Chain)
   (session key,             │            │                 │        (Postgres)     │            ╰── mirror ──▶ GraspLog (Ethereum/L2)
    attestation)             │            ▼                 │                       │
                             │      bundle store (S3, CAS)  │                       ▼
                             │                              ▼                  LicenceRegistry ◀── buyer pays USDC
                             ▼                          verifiers ──▶ claim leaves      │
                          consent service ◀── contributor revokes (signed)              ▼
                                                                                    indexer ──▶ API ──▶ report / verify page / dashboards
```

Trust boundaries: the supplier is trusted for L1 claims only to the extent
of its key; the device manufacturer for L2; THENAR as anchorer is trusted not
to omit (mitigated by multisig, mirrors and public audit); THENAR as verifier
is trusted for L3 until third-party verifiers exist; the chain is trusted for
ordering and timestamps only. Nothing trusts the payload.

---

## 12. FINAL INVESTMENT THESIS

**What is THENAR?** Today: a correct, small, well-tested transparency log
with consent revocation and licence receipts, wrapped in a data-and-hardware
company that has no data and no hardware.

**What should it become?** The neutral provenance and rights ledger for
physical-AI training data — Certificate Transparency for machine experience —
with a verification layer on top and device attestation beneath.

**Category:** physical-AI data provenance. It can be owned because it does not
exist yet and the incumbents (capture suppliers) are structurally barred from
it by their own conflict of interest.

**Why now:** AI Office enforcement began 2026-08-02; $300M+ of capture supply
was funded in 12 months and must now sell to enterprise counsel; LeRobot v3
gives one ingest format; C2PA hardware signing shows attestation is shippable.

**Who pays:** suppliers (to close deals), buyers (to de-risk purchases),
settlement take. Later: fleet operators pooling data.

**Why they pay:** a $200k–$2M data purchase, or a supplier's whole pipeline,
becomes defensible to counsel, regulator and insurer with a report they can
check without trusting anyone.

**Why they can't build it themselves:** they can build the code; they cannot
be neutral, and a relying party will not accept a self-run log.

**Why blockchain:** one canonical head nobody can fork, a timestamp nobody
administers, a receipt neither side can revise. Small job, honestly small.

**Why Avalanche:** USDC-native settlement, cheap finality, an institutional
payments story counsel find legible, and an L1 path for a future consortium
log. A good choice, not a necessary one; the protocol mirrors elsewhere.

**Moat:** neutrality, relying-party network, OEM attestation integrations,
verification track record, lineage switching costs — in that order.

**Network effect:** dedup and plausibility checks get stronger with every
logged episode, and only the neutral log sees everyone's.

**Wedge:** the Provenance Report on real corpora changing hands, then the
recorder SDK.

**What could kill it:** buyers refusing to pay a premium for L2/L3 data;
Hugging Face or Encord shipping a "good enough" provenance layer first;
enforcement never arriving; the founders refusing to let go of hardware.

**Single most important technical breakthrough:** not cryptographic. It is
the L3 verifier — near-duplicate/replay/sim-vs-real detection that works
across suppliers — because that is the first claim buyers will pay a premium
for and the only one that compounds with log size.

**Build next:** defined payload hashing, corpus-manifest and claim leaves,
signed revocation, the ingest service, the L3 verifier v1, the report. Deploy
on Fuji, then C-Chain, with an Ethereum mirror.

**Do not build:** a browser simulator, a wearable, a token, an L1, a
marketplace, a contributor app, anything with "Contact Audit" in the name.

**The $500k / 12-month bet.** Two protocol engineers, one ML engineer for
verification, one founder selling. Months 1–3: protocol fixes, ingest, L3 v1,
three unpaid reports on public LeRobot datasets published as case studies.
Months 3–6: three paid reports; SDK alpha with two suppliers; C-Chain mainnet
with USDC receipts; Ethereum mirror. Months 6–12: attestation for one headset
and one robot compute board; ten suppliers logging; first buyer's counsel
asking for a THENAR report unprompted; ISO 26264 liaison. Refuse: the Band
validation study, MuJoCo WASM, any token, any own-chain, any "network" launch,
any claim above the evidence. If by month 12 L3 episodes carry no price
premium, the company is a compliance SaaS worth building at $20M, not $1B —
and the log will still be the honest record of what it proved.

---

### 2.7 Sources

- XDOF launch, $70M, ABC-130K — [SiliconANGLE](https://siliconangle.com/2026/06/17/robotic-teleoperation-data-startup-xdof-launches-70m-funding/), [Hugging Face dataset card](https://huggingface.co/datasets/XDOF/ABC-130k), [RuntimeWire](https://runtimewire.com/article/xdof-70m-abc-130k-robot-training-data)
- Supplier landscape (Mecka, Tacta, Encord, Config, Micro1) — [Teahose robotics training data guide](https://www.teahose.com/guides/robotics-training-data), [DreamVu 2026 landscape](https://www.dreamvu.ai/blog/robot-training-data-companies-2026)
- Tacta Systems ($75M, gloves, TactaBot) — [The Robot Report](https://www.therobotreport.com/tacta-systems-takes-aim-high-skilled-manufacturing-work-tactabot/), [PR Newswire](https://www.prnewswire.com/news-releases/tacta-systems-unveils-breakthrough-robotic-hands-for-high-value-manufacturing-powered-by-dexterous-intelligence-and-large-scale-skill-capture-302835396.html)
- Market size and teleop pricing — [MarketIntelo report](https://marketintelo.com/report/robotic-teleoperation-data-infrastructure-market), [Truelabel provider guide](https://truelabel.ai/teleoperation-data-marketplace)
- Tactile/force data gap — [AgiBot World 2026 (Pebblous)](https://blog.pebblous.ai/blog/agibot-world-2026-tactile-contact-dataset/en/), [TaF-VLA](https://arxiv.org/html/2601.20321v1), [Forceful foundation models survey](https://arxiv.org/pdf/2504.11827)
- Licence audit burden, unlicensed datasets — [Truelabel HF licence review](https://truelabel.ai/blog/huggingface-robotics-dataset-license-review), [GSDSI provenance & lineage](https://www.gsdsi.com/resources/data-provenance-lineage-for-ai-training-licenses-2026)
- EU AI Act dates and Article 10 — [Humans in the Loop](https://humansintheloop.org/eu-ai-act-training-data-what-high-risk-ai-teams-must-know/), [Kovrr](https://www.kovrr.com/blog-post/what-data-is-required-for-eu-ai-act-compliance)
- LeRobot / OXE adoption, ISO/WD 26264-1 — [LeRobot paper](https://arxiv.org/html/2602.22818v1), [Pebblous ISO note](https://blog.pebblous.ai/report/humanoid-robot-data-iso-standard/en/)
- Fleet data engines (Figure, Agility, Tesla) — [Meta Intelligence](https://www.meta-intelligence.tech/en/insight-physical-ai), [EVSInt teleop guide](https://www.evsint.com/embodied-ai-data-collection-teleoperation-sim-to-real-2026/)
- Crypto robotics (PrismaX, BitRobot) — [KuCoin](https://www.kucoin.com/news/flash/2026-robotics-sector-highlights-major-projects-and-funding-rounds), [Tiger Research](https://reports.tiger-research.com/p/crypto-robotics-eng)
- C2PA hardware signing — [SoftwareSeni](https://www.softwareseni.com/c2pa-adoption-in-2026-hardware-platforms-and-verification-reality/), [Canon](https://global.canon/en/news/2026/20260511.html)
- Avalanche institutional/payments — [Nansen Q2 2026](https://nansen.ai/post/avalanche-q2-2026-report), [VanEck](https://www.vaneck.com/offshore/en/news-and-insights/blogs/digital-assets/matthew-sigel-avalanche-201-the-institutional-platform/), [avax.network/payments](https://www.avax.network/payments)
- Robotics provenance framing — [lakeFS](https://lakefs.io/blog/data-provenance-robotics/)
