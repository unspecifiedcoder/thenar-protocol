# Every task, end to end

Ordered by dependency, not by appeal. Anything marked **DONE** is verified on
chain or in a passing test suite today; everything else is not started.

Legend — **S** small (under a day) · **M** medium (2–5 days) · **L** large (1–3 weeks)

---

## 0. Shipped

| | Task | |
| --- | --- | --- |
| ✅ | `GraspLog` — append-only anchor, monotonic head, sparse-tree revocation | [`0x10325941…`](https://testnet.monadscan.com/address/0x10325941C86397a4355b4801dC28EDf6c41F3c6f) |
| ✅ | `GraspMarket` — terms and payment in one transaction | [`0x0f87309F…`](https://testnet.monadscan.com/address/0x0f87309F410BDBB13B3E0d5c206e7aAC1397fBFa) |
| ✅ | `TaskRegistry` — curators publish tasks, curator share capped at 30% | [`0x70244c42…`](https://testnet.monadscan.com/address/0x70244c42300f427a721a86416331d2a8d6ce2a51) |
| ✅ | `FoundryMarket` — corpus sealing, quality-weighted split, credit-on-refusal | [`0x754845ff…`](https://testnet.monadscan.com/address/0x754845ff489f16a4a216562f0029aea29c678bad) |
| ✅ | `EpisodeLeaf` — 197-byte leaf binding task, world seed, success, quality | |
| ✅ | TaskSpec schema, validator, canonical hashing | |
| ✅ | Deterministic scene sampler, χ²-verified uniform | |
| ✅ | Embodiment registry — 58 models, every licence recorded | |
| ✅ | `/verify` — anyone checks a capture against the chain, no server of ours | [thenar.io/verify](https://thenar.io/verify) |
| ✅ | 60 contract tests, 26 protocol checks, two on-chain e2e proofs | |

---

## 1. The world builder — the critical path

Nothing else matters until a curator can author a task without writing JSON.

| | Task | Size | Notes |
| --- | --- | --- | --- |
| 1.1 | Vendor MuJoCo Menagerie, pinned per model version | S | Licences differ per directory; record each. |
| 1.2 | MJCF → web asset pipeline (meshes to glTF, textures, LODs) | M | Menagerie meshes are STL/OBJ; the browser wants glTF. |
| 1.3 | MuJoCo WASM build + virtual filesystem loader | M | The engine needs its XML and meshes in a VFS before it will step. |
| 1.4 | Scene canvas: place, rotate, snap objects | M | three.js + transform controls. |
| 1.5 | **Range authoring by dragging bounds, not typing numbers** | M | The whole differentiator. A curator drags a pose envelope and sees it. |
| 1.6 | Live sampler preview — reroll the seed, watch the scene change | S | Uses the shipped sampler. Makes variation legible. |
| 1.7 | Predicate builder over the eight-verb vocabulary | M | `on`, `in`, `upright_on`, `within`, `grasped`, `released`, `settled`, `near`. |
| 1.8 | Live predicate evaluation against the stepped scene | M | Curator sees success fire. Without this they are guessing. |
| 1.9 | Validation panel wired to `validateTaskSpec` | S | Already written; surface the errors and the no-variation refusal. |
| 1.10 | Publish flow — hash the spec, sign, write to `TaskRegistry` | S | Contract is deployed and tested. |
| 1.11 | Object/asset library with categories and instances | M | Needed before `instances: [...]` means anything. |

## 2. The capture loop

| | Task | Size | Notes |
| --- | --- | --- | --- |
| 2.1 | Task browser — open tasks, reward, slots, embodiment | S | |
| 2.2 | Episode runner: sample a seed, build the scene, step physics | M | |
| 2.3 | `ee_pose_gripper` control with IK | M | The only action space a cursor can honestly drive. |
| 2.4 | `base_velocity` control for quadrupeds | S | |
| 2.5 | **`whole_body_retarget` gated behind a real input device** | L | Do not ship a humanoid task drivable by mouse. |
| 2.6 | Trajectory recording at fixed rate, with the seed | S | |
| 2.7 | Predicate evaluated at runtime → success flag | M | |
| 2.8 | Quality scoring (placement, smoothness, time against par) | M | Prior art exists; port it. |
| 2.9 | Episode submission → 197-byte leaf → batch queue | S | |

## 3. Anchoring and acceptance

| | Task | Size | Notes |
| --- | --- | --- | --- |
| 3.1 | Off-chain log service: append leaves, keep the CT tree | M | The tree is the product; the chain only anchors it. |
| 3.2 | Hourly anchor job (root, size, revocation root) | S | ~24 transactions a day. |
| 3.3 | Inclusion and consistency proof API | S | Libraries are written and tested. |
| 3.4 | Acceptance pipeline: score, threshold, accept or reject | M | Below `minScoreBps` earns nothing and does not enter the corpus. |
| 3.5 | Duplicate and replay detection | M | A trajectory replayed with jitter must be caught. |
| 3.6 | Consent withdrawal endpoint → sparse tree → anchored | M | |
| 3.7 | Corpus sealing job → `sealCorpus` with the quality cap table | S | |

## 4. Export and the buyer surface

| | Task | Size | Notes |
| --- | --- | --- | --- |
| 4.1 | **LeRobotDataset v3 export** — Parquet + MP4 + metadata | M | 16k+ datasets use it. This is the format buyers expect. |
| 4.2 | RLDS/TFRecord export for Open X-Embodiment pipelines | M | Secondary, but it is what the big pretraining corpora ingest. |
| 4.3 | Corpus catalogue: task, size, quality distribution, price | M | |
| 4.4 | Sample pack — a free slice a buyer can train on before paying | S | Removes the biggest objection in the sales call. |
| 4.5 | Licence purchase flow in the browser | S | Contract deployed and tested. |
| 4.6 | Post-purchase delivery, gated on the receipt | M | |
| 4.7 | Provenance report a buyer's counsel can read | M | The actual product. Inclusion proofs, consent status, licence version. |

## 5. Curator and contributor surfaces

| | Task | Size | Notes |
| --- | --- | --- | --- |
| 5.1 | Curator dashboard — tasks, fill rate, earnings | M | |
| 5.2 | Contributor portfolio — episodes, quality, payouts | M | |
| 5.3 | Leaderboards by quality, not volume | S | |
| 5.4 | Withdrawal for credited balances | S | Contract has `withdraw()`. |
| 5.5 | Curator onboarding: what makes a task good | M | Docs plus a worked example. This is your quality moat. |

## 6. Trust, and the things that will be asked in diligence

| | Task | Size | Notes |
| --- | --- | --- | --- |
| 6.1 | **Per-model licence audit before commercial ship** | S | 58 models. Spot, UR, KUKA flagged for trademark. |
| 6.2 | External security review of all four contracts | M | Before real money. |
| 6.3 | Anchorer key in a multisig, not a hot wallet | S | One key currently controls the head. |
| 6.4 | Data-protection position: consent, erasure, salted commitments | M | Write it down before a buyer's counsel asks. |
| 6.5 | Terms of use for contributors and buyers | M | Lawyer, not template. |
| 6.6 | Reproducibility harness: rebuild any episode's scene from its leaf | S | The claim `/verify` makes; prove it end to end. |

## 7. Real hardware — where the money actually is

Simulated corpora are the design and recruitment surface. The 5,000–20,000
episodes a buyer pays for are real hardware.

| | Task | Size | Notes |
| --- | --- | --- | --- |
| 7.1 | Real-robot capture client emitting the same leaf format | L | One embodiment first — SO-ARM100 or Franka. |
| 7.2 | Calibration and attestation for a capture rig | L | The gap between provenance and proof of measurement. |
| 7.3 | Band integration — contact channels into the manifest | L | The differentiator. |
| 7.4 | Biomechanics validation before any force claim | L | Must precede marketing the Band's numbers. |
| 7.5 | First paid Contact Audit on a named failing task | M | Revenue without a network. |

## 8. Go to market

| | Task | Size | Notes |
| --- | --- | --- | --- |
| 8.1 | Publish 3–5 reference tasks yourself, to standard | M | Nobody curates into an empty registry. |
| 8.2 | Seed 500+ episodes on one task to prove the loop at size | M | |
| 8.3 | Ten named targets with a published manipulation failure | S | Papers, issue threads, demo videos where a grasp slips. |
| 8.4 | Pricing: simulated versus real, per episode | S | Price them differently and say why. |
| 8.5 | Avalanche deployment, or amend the protocol page | S | The page argues the C-Chain; the deployment is Monad. |

---

## The five that actually gate everything

1. **1.3 MuJoCo WASM + VFS.** No physics in the browser, no builder, no capture.
2. **1.5 Range authoring by dragging.** Without it curators publish fixed scenes and the corpus is worthless.
3. **1.8 Live predicate evaluation.** A curator who cannot see success fire is guessing.
4. **4.1 LeRobot v3 export.** Without it a buyer writes an adapter, and most will not.
5. **7.1 Real-hardware capture.** Until this exists there is no product anyone pays the real number for.

## What I would not build yet

- Tokenised corpus shares or any tradable instrument. It invites a securities
  question you do not need while pre-revenue.
- Your own L1. The traffic is tens of transactions a day; it is the first thing
  a reviewer kills.
- A mobile capture app. The desktop loop is not proven yet.
- More embodiments in the builder than you have tasks for. Fifty-eight models
  are registered; ship three well.
