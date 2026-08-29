# THENAR — test plan

Every page, asset, endpoint, contract call and flow that exists today, with what
"correct" means for each. A pass means the observed result matches the
**Correct** column exactly, with a clean console and no failed requests beyond
the deliberate negative tests.

Target: https://thenar.io · Monad Testnet, chain `10143`

| Contract | Address |
| --- | --- |
| `GraspLog` | `0xe9950e8377787d6d6c4c6bda9e4188925a18da6a` |
| `LeafVerifier` | `0x0d789ee35382e1ea06ed0d82f55dcbf4c6130356` |
| `TaskRegistry` | `0xf99bdc3512b074d7b6d21cb609ff05e54f465d24` |
| `FoundryMarket` | `0x735057412d1ef884a28bc409731a6f91679265f3` |

---

## Pages

| # | Item | Correct means |
| --- | --- | --- |
| P1 | `/` | 200. Title "THENAR — contact data for physical AI". The page module executes: clicking the trace's Pause toggles its label. |
| P2 | `/` rigs | All seven canvases size to their CSS box once scrolled into view (backing ≠ 300×150) and none stays blank. |
| P3 | `/` ledger | `#chainc` reads `GraspLog` over JSON-RPC and draws the anchors the chain holds, labelled "READ LIVE FROM THE CONTRACT — NOT A SIMULATION". Never invents blocks. |
| P4 | `/` ledger, RPC down | With the RPC unreachable the strip says it could not reach Monad and draws nothing. |
| P5 | `/products` `/protocol` `/market` `/faq` `/company` `/terms` `/privacy` | 200 each, content renders. |
| P6 | `/404` | An unknown path renders the in-world 404, title "Page not found — THENAR". |
| P7 | Nav | Every page links Products, Protocol, Market, FAQ, Company, Corpora, Verify. No dead links; `.html` URLs 308 to the clean route and resolve 200. |
| P8 | Mobile 500px | No horizontal body scroll on any page; wide tables scroll in their own container. |

## `/corpus`

| # | Item | Correct means |
| --- | --- | --- |
| K1 | Loads | 200. While reading, a spinner and "Reading the market…". |
| K2 | Renders real corpora | One card per corpus on chain, with episodes covered, contributor count, licence price and licences sold — all matching a direct contract read. |
| K3 | Fee split | Protocol 2.50% + curator share + contributor pool sum **exactly** to the licence price. |
| K4 | Cap table | Contributor rows sum exactly to the contributor pool; percentages sum to 100%; the bar has one segment per contributor. |
| K5 | Histogram | One bar per bin over the committed weights, tallest bin marked. |
| K6 | Copy | Clicking a hash or address copies it and confirms, then restores the label. |
| K7 | Empty state | With no corpora, says so plainly rather than rendering an empty list. |
| K8 | RPC failure | Says it could not reach Monad; does not invent a corpus. |

## `/verify`

| # | Item | Correct means |
| --- | --- | --- |
| V1 | Loads | 200. Log and market addresses render and link to the explorer. Head reads "N captures across M anchors" matching `anchorCount`. |
| V2 | Anchor table | One row per anchor, newest first, with index, root, size, block, and whether it carries a withdrawal. |
| V3 | Capture sample | "Load a real capture" fills the form; asking the contract answers **in the log**. |
| V4 | Episode sample | "Load a real episode" fills the form; asking answers **in the log**, and the decoded panel appears. |
| V5 | Decoded facts | Six fields — verdict, quality, world seed, duration, channels, captured — decoded from the preimage, matching what `LeafVerifier.episodeFacts` returns. |
| V6 | Scene rebuild | The canvas draws the world for that task and seed, sized to its box, with a caption naming the task and seed. Identical to the exporter's sampler. |
| V7 | Capture shows no world | A 154-byte capture hides the decoded panel — it carries no task or seed. |
| V8 | Tamper | One byte changed → **not in the log**. |
| V9 | Bad anchor | An index past the end → "There is no anchor #N. The log has M, numbered 0 to M−1." Never a raw revert. |
| V10 | Non-hex | "That preimage is not hexadecimal." |
| V11 | Odd digits | "That preimage has an odd number of hex digits, so it is not whole bytes." |
| V12 | Wrong length | Names the actual byte count and both valid lengths. |
| V13 | Deep link | A successful check rewrites the URL with anchor, leaf, preimage, proof and `go=1`; loading that URL re-runs the check and answers in the log. |
| V14 | Keyboard | `e` loads the episode, `s` the capture, ⌘↵ submits; all ignored while typing in a field. |

## Static assets

| # | Item | Correct means |
| --- | --- | --- |
| A1 | Modules | `gl.js` `grasp.js` `hotaru.js` `band.js` `bandview.js` `grasp-chain.js` `corpus.js` `scene.js` `keccak.js` all 200. |
| A2 | Import integrity | Every module a page imports exists; no shipped module is unreachable. |
| A3 | Samples | `/sample-proof.json` `/sample-episode.json` `/sample-task.json` 200, and both proofs verify against the live chain. |
| A4 | Addresses | `grasp-chain.js` carries the four addresses in `.env.contracts`. |
| A5 | SEO | `/robots.txt` and `/sitemap.xml` 200; every route in the sitemap resolves 200. |
| A6 | Styles | `site.css` and `chainui.css` 200. |

## API

| # | Item | Correct means |
| --- | --- | --- |
| E1 | `GET /api/join` | 405 with an `Allow: POST` header. |
| E2 | Bad email | 400, "That email address does not look right." |
| E3 | Empty body | 400, "Tell us your name." |
| E4 | Valid submit | Either sends via Resend, or fails **loudly** with 503 and a usable fallback. Never a cheerful 200 that drops the person. |
| E5 | Form default | The form carries `method="post" action="/api/join"`, so a submit that outruns the script cannot put a name and email in the URL. |
| E6 | Double submit | Simultaneous submits produce exactly one request; the button restores to "Send it". |
| E7 | Validation | Empty name and email each produce a specific message, `aria-invalid="true"`, and focus moves to the first bad field. Whitespace-only name rejected. |

## Contracts — reads

| # | Item | Correct means |
| --- | --- | --- |
| C1 | Deployed | All four addresses carry bytecode. |
| C2 | Verified | All four report `full` on Sourcify. |
| C3 | Anchor chain | Every anchor's `prevRoot` equals the previous anchor's `root`; size strictly increases. |
| C4 | Anchor coherence | For **every** anchor the chain holds, the stored size is the size of the tree its root came from — audited against the store, reporting coherent / unverifiable / mismatched. |
| C5 | Capture inclusion | A real capture preimage + proof returns true through both `verifyClip` and `verifyLeaf`. |
| C6 | Episode inclusion | A real 197-byte episode + proof returns true through `verifyLeaf`. |
| C7 | Episode facts | `episodeFacts` returns the task, seed, verdict and score committed in the preimage. |
| C8 | Version guards | Unknown version, empty preimage, and version/length disagreement each revert with a named error. |
| C9 | Task registry | The published task reads back with its curator, share and target. |
| C10 | Cap table | Weights sum to the recorded total and differ between contributors. |
| C11 | Append-only | A consistency proof between two anchors returns true. |
| C12 | Consent live | A key never revoked proves non-membership against the anchored revocation root. |

## Flows

| # | Item | Correct means |
| --- | --- | --- |
| F1 | Verify a capture end to end | Load the sample on `/verify`, ask the contract, get "in the log", zero console errors. |
| F2 | Verify an episode end to end | Same, plus decoded facts and a rebuilt world. |
| F3 | Share a verification | Copy the URL after a successful check, open it fresh, and it re-verifies to the same answer. |
| F4 | Corpus → contract agreement | Every figure on `/corpus` matches a direct contract read. |
| F5 | Scene determinism | The same task and seed rebuild the same world; a different seed does not. |
| F6 | Export | `pnpm export` produces a LeRobot v3 corpus whose episode count matches the filtered store, each episode carrying its leaf, anchor and seed. |

## Suites

| # | Item | Correct means |
| --- | --- | --- |
| S1 | `forge test` | Every Solidity suite passes. |
| S2 | `pnpm test:protocol` | Protocol, foundry, episode and selector checks all pass. |
| S3 | `pnpm test:log` | Log store checks pass. |
| S4 | `pnpm test:export` | Exporter checks pass. |
| S5 | `pnpm test:web` | Grasp timeline, import integrity, keccak and scene sampler all pass. |
| S6 | Cross-implementation | Browser keccak matches viem; browser sampler matches the exporter. |

## Global

| # | Item | Correct means |
| --- | --- | --- |
| G1 | Console | Zero errors on every page. |
| G2 | Network | Zero failed requests on every page, other than the deliberate 503 from a form submission with no mail credential. |
| G3 | No mocks | Zero mock/stub/fake/placeholder/TODO in shipped code. |
| G4 | CI | The workflow runs every suite. |


---

## Result of this run

**71 items · 71 PASS · 0 FAIL · 1 partially untestable.**

Three failed on first pass and were fixed:

- **G4** — CI ran `forge test`, `test:log`, `test:protocol` and `test:samples`
  but not `test:export` or `test:web`, so 72 checks sat unguarded, including
  the two cross-implementation ones that stop the site rebuilding the wrong
  world. Both added. A new guard, `packages/protocol/test/ci.ts`, now fails the
  build if a declared suite is missing from the workflow — and it immediately
  caught a second gap, that `pnpm test` did not chain `test:samples` either.
- **K6** — the copy fallback said "press ⌘C" without selecting anything, which
  is an instruction that does not work. It now puts the full value on the page
  and selects it, so the keystroke actually copies.
- **K7** — the empty state could not be reached in a browser, because the real
  market is never empty and my attempts raced the page's own render. `corpus.js`
  now exports `render` and `renderError`, and `apps/web/test/corpus.test.mjs`
  drives both states directly.

**E4 is partially untested.** `RESEND_API_KEY` exists nowhere — not the repo,
not `.env*`, not the Vercel project — so the send path cannot be exercised. What
was verified is that the failure is loud and useful: 503, a readable message,
and a fallback address. The success path stays unverified until the key exists.

Two items are limited by the harness rather than the app, and are recorded as
such: **P2** (canvas sizing) and the grasp animation both run inside
`requestAnimationFrame`, which Chrome throttles under CDP when the tab is not
painting — `makeGrasp` returned zero ticks in three seconds of polling. Both
verify under real scrolling, which paints; P2 passes that way, and the grasp
timeline is covered headlessly in `apps/web/test/grasp.test.mjs` with a fake
clock instead.
