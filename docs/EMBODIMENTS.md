# The embodiment catalogue

Research for the foundry. What robot models exist, what they cost to use, and
which ones a curator can design tasks against today.

## The finding that changes the plan

**You do not need to onboard OEMs to get 3D models.** MuJoCo Menagerie, curated
by Google DeepMind, already carries ~60 simulation-ready robots and **every one
of them is permissively licensed** — MIT, Apache-2.0, BSD-2-Clause or
BSD-3-Clause. All commercially usable. No negotiation, no contracts, no waiting.

That reorders the roadmap. Onboarding manufacturers is still worth doing, but
for three narrower reasons: embodiments Menagerie lacks, commercial legitimacy
and co-marketing, and proprietary hardware a customer wants tasks designed for.
It is a business-development track, not a prerequisite for launch.

Caveat before shipping commercially: the licence file sits per model directory,
and a permissive licence on the MJCF does not automatically settle trademark or
mesh-provenance questions for a manufacturer's branded hardware. Check each
model you ship, individually, and record the result. Boston Dynamics and the
OEM-branded arms deserve a lawyer's ten minutes, not an assumption.

---

## Humanoids

The category the plan cares about most. Eleven, all permissive.

| Robot | DoF class | Licence | Why it matters |
| --- | --- | --- | --- |
| **Unitree G1** | 23–43 | BSD-3-Clause | The volume humanoid. Cheapest real hardware, widest community, most existing teleop data. Start here. |
| **Unitree H1** | 19 | BSD-3-Clause | Full-size, high-power. The locomotion-and-loco-manipulation story. |
| **Apptronik Apollo** | ~30 | Apache-2.0 | Commercial warehouse humanoid. Credible for logistics tasks. |
| **Booster T1** | ~23 | Apache-2.0 | Newer entrant, active community. |
| **Fourier N1** | ~23 | Apache-2.0 | Chinese full-size; Fourier is shipping units. |
| **PAL TALOS** | 32 | Apache-2.0 | European research standard, torque-controlled. |
| **Berkeley Humanoid** | 12 | BSD-3-Clause | Small, open, cheap to reproduce. Good for locomotion. |
| **Robotis OP3** | 20 | Apache-2.0 | Small hobby-class. Low value commercially, good for tooling tests. |
| **PNDbotics Adam Lite** | ~25 | MIT | |
| **ToddlerBot 2XC / 2XM** | ~30 | MIT | Small, printable, genuinely open. |
| **Agility Cassie** (biped) | 10 | MIT | Legs only. Locomotion benchmark, not manipulation. |

**The hard truth about humanoid tasks:** a G1 has 23–43 actuated joints. Nobody
produces trainable manipulation data for that with a mouse and keyboard. Whole-
body humanoid teleoperation is an active research problem — the 2026 literature
is full of retargeting solvers and VR rigs precisely because it is unsolved with
commodity input. Any humanoid task a curator publishes has to either reduce the
action space (end-effector pose + gripper, with the rest solved by a controller)
or require a real input device. Pretending a browser cursor drives a humanoid is
the fastest way to produce a corpus nobody buys.

---

## Quadrupeds

| Robot | Licence | Note |
| --- | --- | --- |
| **Unitree Go2** | BSD-3-Clause | The volume quadruped. |
| **Unitree Go1 / A1** | BSD-3-Clause | Prior generations, still widely deployed. |
| **ANYmal B / C** | BSD-3-Clause | Industrial inspection. Real commercial deployments. |
| **Boston Dynamics Spot** | BSD-3-Clause | Highest brand recognition. Check trademark before commercial use. |
| **Google Barkour v0 / vB** | Apache-2.0 | Benchmark platform. |

Quadrupeds are mostly a **locomotion and inspection** story, not manipulation —
unless paired with an arm (Spot + arm, Go2 + Z1). That pairing is the
commercially interesting one, and it is where "industrial inspection data" as a
product lives.

---

## Arms — the commercially proven category

Twenty models. This is where manipulation data actually sells today, and where
your existing capture story already fits.

| Robot | Licence | Note |
| --- | --- | --- |
| **Franka Emika Panda / FR3** | Apache-2.0 | The research standard. Most published datasets use it. |
| **Universal Robots UR5e / UR10e** | BSD-3-Clause | The industrial standard. Highest install base in real factories. |
| **KUKA LBR iiwa 14** | BSD-3-Clause | Industrial, torque-controlled. |
| **Kinova Gen3** | BSD-3-Clause | Research and assistive. |
| **Flexiv Rizon 4 / 4S** | Apache-2.0 | Force-controlled — directly relevant to contact data. |
| **xArm7 / Lite 6** | BSD-3-Clause | High volume, low cost. |
| **ViperX 300 / WidowX 250** | BSD-3-Clause | The Trossen arms behind ALOHA and much open data. |
| **ARX L5**, **AgileX PiPER**, **Unitree Z1** | BSD-3 / MIT | Low-cost Chinese arms, rising fast. |
| **SO-ARM100 / Low-Cost Arm / YAM** | Apache-2.0 / MIT | Sub-$500 arms. The LeRobot community's default. |
| **Rethink Sawyer** | Apache-2.0 | Legacy but well-documented. |

**Bimanual:** ALOHA (BSD-3-Clause) — the reference bimanual platform, and the
one most imitation-learning work targets.

---

## Hands and end-effectors — your actual differentiator

This is the category that matters most for a *contact data* company, because
grip force and slip only exist at the hand.

| End effector | Licence | Note |
| --- | --- | --- |
| **Shadow Hand E3M5** | Apache-2.0 | 24 DoF, the dexterity benchmark. |
| **Shadow DEX-EE** | Apache-2.0 | Newer, built for RL. |
| **Allegro Hand V3** | BSD-2-Clause | 16 DoF, the most common research hand. |
| **Leap Hand** | MIT | Low-cost, open, printable. Community favourite. |
| **Robotiq 2F-85** | BSD-2-Clause | The industrial gripper. |
| **UMI Gripper** | MIT | Handheld data collection — directly adjacent to the Band. |
| **Sharpa Wave** | Apache-2.0 | Tactile-focused. |
| **Panda / xArm7 grippers** | Apache-2.0 / BSD-3 | |

**UMI is worth studying closely.** It is a handheld gripper that collects
manipulation data without a robot — the same insight as the Band, from the
other direction. It is the closest existing thing to what you are building, and
it is MIT licensed.

---

## Mobile manipulators

Stretch 2 (BSD-3-Clause-Clear) and Stretch 3 (Apache-2.0), PAL TIAGo and
TIAGo++ (Apache-2.0), Google Robot (Apache-2.0), Stanford TidyBot (MIT).

Household and light-logistics story. Stretch has real deployments in homes.

---

## Formats, and getting them into a browser

Three formats dominate and conversion between them is lossy:

- **URDF** — ROS native. Kinematics and visual/collision meshes. No actuator or
  contact model.
- **MJCF** — MuJoCo native. Carries actuators, contact parameters, solver
  settings. This is what Menagerie ships and what a physics-accurate task needs.
- **USD** — NVIDIA Isaac / Omniverse. Scene-level composition, best for large
  worlds and rendering.

For the web, the practical chain is **MJCF → MuJoCo WASM for physics**, with
meshes rendered via three.js. Existing prior art: `mechaverse` renders
URDF/MJCF/USD in-browser on three.js; `urdf-loader` is the mature npm path for
URDF; URDF-Studio exports to MJCF, USD and SDF from a browser editor.

**MuJoCo compiles to WebAssembly and runs contact-rich physics in the browser.**
That is the keystone technical fact for the whole foundry idea: a curator can
build a world and a contributor can drive it, both in a tab, with the same
physics the buyer will train against. It needs a virtual filesystem to feed the
engine its meshes and XML, which is a solved plumbing problem.

---

## The data format is already decided — do not invent one

**LeRobotDataset v3** is the de facto standard: 16,000+ datasets from 2,200+
contributors. Low-frequency-decoupled storage — states, actions and timestamps
in Apache Parquet, camera streams in MP4, schema and episode index in metadata,
with episode-level access exposed over the top.

**Open X-Embodiment** uses **RLDS** (TFRecord-based), which is what the large
cross-embodiment pretraining corpora ship as.

Emit LeRobot v3 as the primary export and RLDS as a secondary, and every corpus
the foundry produces is trainable on day one with no adapter written by the
buyer. Inventing a Thenar format would be the single most expensive unforced
error available.

---

## Task design has prior art worth copying exactly

- **LIBERO** — 130 tasks across four suites (Spatial, Object, Goal, Long), each
  probing a different generalisation axis, at 50 demonstrations per task for
  ~6,500 trajectories.
- **RoboCasa** — large-scale household tasks with heavy *intra-task* variation:
  scenes, objects, and initial poses all vary within one task. This is the
  distinction that matters.
- **BEHAVIOR-1K** — 1,000 household activities, the widest task ontology.

**The lesson for the curator tool:** a task is not a scene. A task is a
*distribution over scenes*. LIBERO fixes layouts and varies one axis at a time;
RoboCasa varies scene, object instance and initial pose within a single task,
and that is why RoboCasa data generalises better. A curator who publishes one
fixed arrangement has published a demo, not a dataset.

So the world builder needs randomisation as a first-class primitive, not a
feature: object pose ranges, instance swaps from a category, lighting and
texture variation, distractor counts. The curator authors the *ranges*; the
platform samples them per episode.

---

## The market, and where the money actually is

Robotic teleoperation data infrastructure: **~$320M in 2025, ~$420M in 2026,
30.2% CAGR, ~$4.3B by 2034.** Early but structuring fast.

The buying pattern in 2026 is hybrid: **pretrain on open datasets, then
fine-tune on 5,000–20,000 net-new episodes under a commercial licence.**

Read that clause again, because it is the whole business: buyers are not short
of data. They are short of data they are *allowed to train on*, with provenance
they can show their counsel. That is precisely the artefact GRASP produces as a
by-product of paying contributors. The protocol is not decoration on the data
business — it is the reason the data is sellable.

Competitors already assembling corpora: Truelabel (sourcing and matching),
Encord, XDOF (out of stealth mid-2026, $70M, released ABC-130K bimanual),
DataX Power (APAC managed programmes), iMerit, Physical Intelligence (internal).

---

## The strategic risk, stated plainly

**Simulated demonstrations and real-robot demonstrations are not the same
product, and the market pays for the second.**

LIBERO and RoboCasa are academic benchmarks, not corpora anyone sells. The
5,000–20,000 episodes a buyer pays for are real hardware, real contact, real
failure modes. A browser-authored simulated corpus is worth a fraction per
episode, and a buyer's first question will be which one they are being offered.

That does not kill the foundry idea. It sequences it:

1. **Simulation is the recruitment and design surface.** Curators design tasks,
   contributors learn the loop, tasks get validated as well-posed, and the
   platform proves it can produce clean LeRobot v3 with provenance — all at zero
   hardware cost.
2. **The corpus that sells is captured on real hardware** against tasks the
   simulator already proved were well-designed, by the same curators.
3. **The Band is what makes that corpus differentiated**, because it carries the
   channel nobody else records.

Sell the sequence honestly. A simulated corpus presented as trainable
manipulation data is the claim that ends a diligence call.
