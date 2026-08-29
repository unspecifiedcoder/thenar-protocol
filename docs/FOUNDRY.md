# The foundry

Curators design worlds and tasks. Contributors produce demonstrations against
them. GRASP records provenance and settles payment. Buyers licence the corpus.

This document is the design for that, written against what already exists on
chain rather than beside it.

---

## The four roles, and what each is paid for

| Role | Does | Paid by |
| --- | --- | --- |
| **Curator** | Designs the world and the task: embodiment, scene distribution, success predicate, acceptance bar | A standing share of every licence sold on corpora produced from their task |
| **Contributor** | Produces demonstrations against a published task | Per accepted episode, and a share of licence revenue by quality weight |
| **Buyer** | Licences a corpus under published terms | — |
| **Thenar** | Runs the log, the simulator, the acceptance pipeline, the Band | Protocol fee on licences, and the Contact Audit engagements |

The curator is the role that does not exist in any competitor. Truelabel matches
buyers to capture suppliers; XDOF and DataX run managed programmes. Nobody pays
a person for *designing a task well*, which is odd, because task design is what
separates a corpus that generalises from one that does not.

---

## What a task actually is

A task is **not a scene**. It is a distribution over scenes, plus a predicate
that decides whether an attempt succeeded.

This is the single most important design decision and it comes straight from the
benchmark literature: LIBERO fixes layouts and varies one axis at a time;
RoboCasa varies scene, object instance and initial pose *within* one task, and
RoboCasa data generalises better. A curator who publishes one fixed arrangement
has published a demo, not a dataset.

```jsonc
// A TaskSpec — authored in the builder, hashed, published on chain.
{
  "version": 1,
  "embodiment": "unitree_g1",          // from the registry
  "actionSpace": "ee_pose_gripper",    // what the contributor actually drives
  "instruction": "Place the mug upright on the shelf",
  "world": {
    "base": "kitchen_counter_v2",
    "objects": [
      { "category": "mug", "instances": ["mug_a","mug_b","mug_c"],
        "pose": { "x": [0.28, 0.42], "y": [-0.15, 0.15], "yaw": [0, 6.283] } },
      { "category": "distractor", "count": [0, 3] }
    ],
    "lighting": { "intensity": [0.6, 1.4], "temperature": [3000, 6500] }
  },
  "success": {
    "predicate": "upright_on(mug, shelf) && settled(2.0s)",
    "tolerance_mm": 25
  },
  "acceptance": { "minScore": 0.55, "maxDurationS": 120, "minEpisodes": 500 }
}
```

The curator authors **ranges**. The platform samples them per episode and
records the seed. Two contributors never get the same scene, and the buyer gets
a corpus with real intra-task variance rather than 500 copies of one arrangement.

### The success predicate is the hard part

A task whose success cannot be checked automatically cannot be a task, because
acceptance would need a human on every episode and the economics collapse. The
predicate language should stay small and physical on purpose: spatial relations
(`on`, `in`, `upright`, `within`), contact facts (`grasped`, `released`),
and settling (`settled(t)`). If a curator cannot express success in that
vocabulary, the task is not ready.

---

## The world builder

Browser, drag-and-drop, and running the *same physics the buyer will train
against* — because MuJoCo compiles to WebAssembly and runs contact-rich physics
in a tab. A curator places objects, sets ranges by dragging bounds rather than
typing numbers, scrubs a sampled scene, and watches the predicate evaluate live.

Stack that follows from the research:

- **Physics** — MuJoCo WASM, fed MJCF from Menagerie through a virtual filesystem
- **Render** — three.js; `urdf-loader` for URDF sources, MJCF meshes direct
- **Embodiments** — Menagerie, vendored and pinned per version
- **Export** — LeRobotDataset v3 primary, RLDS secondary

The builder's real output is not a scene file. It is a `TaskSpec` hash, and a
deterministic sampler that turns `(taskSpec, seed)` into a concrete scene. Given
the spec and the seed, anyone can reconstruct the exact world an episode was
recorded in. That reconstructability is what makes an episode auditable rather
than merely stored.

---

## What changes on chain

The current `ClipLeaf` binds a capture to a licence version. The foundry needs it
bound to a **task** and a **world seed** as well, or a corpus cannot prove what
it is a corpus *of*.

That is a leaf-format change, so it is a new contract rather than an upgrade —
correct, since the current leaf is deployed and receipts referencing it must
stay readable. Proposed additions, keeping the no-identity rule intact:

```
  taskId        bytes32   the published TaskSpec hash
  worldSeed     uint64    the sample that produced this scene
  successFlag   uint8     the predicate's verdict at acceptance
  qualityScore  uint16    the acceptance score, basis points
```

Still no identity, still no payload, still no free text. A leaf gains the ability
to say *which task, which sampled world, and whether it succeeded* — which is
exactly what a buyer filters a corpus on.

**Curator revenue** is the other addition. `GraspMarket` currently pays a
treasury. The foundry needs a split at licence time: curator share, contributor
pool by quality weight, protocol fee. The cap-table mechanics for this are
already proven — the previous protocol did contributor-weighted fan-out in a
single transaction — so this is a port of a solved problem, not new research.

---

## Sequencing, and the risk that decides it

**Simulated demonstrations and real-robot demonstrations are different products,
and the market pays for the second.** The 2026 buying pattern is pretrain on
open data, then fine-tune on 5,000–20,000 net-new episodes *under a commercial
licence*. Those are real hardware.

So the honest sequence:

**Phase 1 — the design surface (no hardware).** Ship the builder, the embodiment
registry, and the simulated capture loop. Recruit curators. Prove the platform
emits clean LeRobot v3 with provenance, and that published tasks are well-posed.
Simulated corpora are sold as what they are: pretraining and task-validation
data, priced accordingly.

**Phase 2 — real capture against validated tasks.** The tasks that survived
simulation get captured on real hardware, by the same curators, with contributors
recruited through Phase 1. This is the corpus that carries commercial value.

**Phase 3 — the Band.** Contact channels nobody else records, on tasks already
proven to matter. This is the differentiated corpus and the reason a buyer picks
Thenar over a capture agency.

The mistake that ends a diligence call is presenting Phase 1 output as Phase 2
product. Price the simulated corpus honestly and the sequence reads as strategy;
blur them and it reads as a data company that has not measured anything.

---

## Why this is defensible

Every competitor found in the research is a **capture service**: they take an
order and staff it. That scales linearly with operators and has no moat beyond
operational quality.

The foundry is a different shape. The curator's task spec is a reusable asset
that keeps earning across every corpus produced from it. The log makes each
corpus independently verifiable without trusting Thenar. And the licence receipt
is the artefact a buyer's counsel actually needs, which is the constraint the
whole market is currently short on.

Data anyone can collect is a commodity. Data with a provable licence, a named
task design, and a contact channel nobody else records is not.
