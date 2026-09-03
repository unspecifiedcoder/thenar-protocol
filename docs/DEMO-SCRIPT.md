# THENAR — judge walkthrough (3–5 minutes)

Narration for the recorded demo (`pnpm demo:record`) and for a live
presentation. One caption per beat; the caption text is what appears on
screen. Speak plainly; never say "authentic", "verified real" or "blockchain
solves". Total ≈ 4 min at a normal pace.

| # | Screen | Caption (on screen) | Say (≈ 20 s each) |
| --- | --- | --- | --- |
| 1 | `/` hero + tape | Provenance and rights for physical-AI data. | Robotics companies now buy training data from third parties. Their counsel asks four questions — what is this, where did it come from, may we train on it, is that still true — and today the answer is a spreadsheet and the vendor's word. THENAR is a public register that answers them with evidence anyone can check. |
| 2 | `/` tape close-up | Every anchor here was read from Avalanche Fuji a moment ago. Nothing is drawn that the chain did not say. | This strip is live. Each stub is one anchoring of the log: its size, its root, the block. The head carries the seal. We never draw a fixture. |
| 3 | `/` badges | Four badges. Each says exactly what it proves — and what it does not. | Committed: the bytes existed by a block and consent still stood. Signed: a named organisation vouched before logging. Attested: the key lived in hardware. Checked: named checks with recorded thresholds. Not a ladder — a set. |
| 4 | `/` source line | Source is declared by the signer. It becomes "attested" only with a hardware-attested robot controller. | This is the line most data products blur. A simulation stays "declared: simulation" no matter how many badges it earns. |
| 5 | terminal: `pnpm demo:golden --live` steps 1–3 | Ingest a real LeRobot dataset. Every episode gets a leaf, a signed receipt, and its checks. | Three real episodes plus one we deliberately jittered. The dedup check flags it — and, because that threshold is still under review, it reports "inconclusive" rather than "fail". Honesty is enforced in code. |
| 6 | terminal: step 3 tx + `/verify` tape update | Anchored on Avalanche Fuji, block 58154513. Same root on the mirror. | One transaction, one head, two chains. The protocol carries no chain id — the same log verifies anywhere. |
| 7 | `/corpus` record card | A corpus is its own Merkle tree, logged as a leaf. Selling it needs a proof, not our word. | Sealing on chain requires an inclusion proof of the corpus manifest. A corpus can never quietly become "the whole log". |
| 8 | terminal: steps 5–6, `license.mjs` receipt | The licence receipt names the terms hash, the corpus root and the manifest hash. Payment and terms in one call. | Mock USDC on testnet; USDC on mainnet. The receipt is the artefact counsel asked for. |
| 9 | `/verify?report=` checklist filling | The buyer verifies offline: file hashes, manifest, inclusion, consistency, consent, claims, corpus. Seven steps, no THENAR server. | Every step names itself. The summary only says "every step passed" when every step passed. |
| 10 | terminal: step 7 revocation-only anchor | A contributor withdraws consent. The head re-anchors at the same size with a new revocation root. | Provenance stays. Rights change. The buyer's earlier receipt still verifies against its own anchor — history is never rewritten. |
| 11 | Provenance Report PDF, cover + limitations page | The report ends with what it does not prove. Verbatim, every time. | Checks are heuristics. A signature proves who signed, not what a sensor saw. We print that on the last page of every report, because the customer's counsel will find it anyway. |
| 12 | terminal: step 8 tamper | One byte flipped. The verifier names the file and the leaf. | That is the whole product: not trust, evidence. |
| 13 | `/` footer, addresses | Live on Avalanche Fuji. 176 contract tests. Open source. | Contracts, log service, checks and the report are in the repository. Next: five public datasets, published duplicate rates, three paid reports. |

## Recording notes
- Viewport 1440×900; captions via the `.caption` bar; ~14 s per beat, 4 min total.
- Terminal beats are pre-recorded transcripts rendered in a `.window` page (`apps/web/samples/demo-transcript.html`) so the video never shows a key.
- Output: `docs/demo/thenar-demo.webm` (+ `.mp4` if ffmpeg is available).
