# 100 ideas, ranked

Ranked by impact × feasibility × fit for an **accelerator reviewer doing
diligence** — not a hackathon judge with five minutes. That audience rewards a
claim they can check themselves and punishes a claim they can't. It also
punishes clutter: a pile of disconnected features reads as a team that could not
decide what the product was.

Scores are 1–5. **Rank = impact × feasibility × fit**, max 125.
Status: **BUILT** · **SKIPPED** (with reason) · **OPEN**

## Tier 1 — build these (rank ≥ 60)

| # | Idea | I | F | Fit | Rank | Status |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `/corpus` catalogue: every sealed corpus read from `FoundryMarket`, with size, contributors, price, quality spread | 5 | 5 | 5 | 125 | **BUILT** — `/corpus`, real chain reads, fee split balances to the wei |
| 2 | Scene reconstruction in the browser: rebuild a world from `taskId` + `worldSeed` and draw it — the "auditable, not merely stored" claim made visible | 5 | 4 | 5 | 100 | **BUILT** — `scene.js`, agrees with the exporter on 310 seeds |
| 3 | Download the LeRobot v3 corpus from the site as a real file | 5 | 4 | 5 | 100 | **SKIPPED** — the exporter is real and tested, but serving a file needs a build step the static site does not have; `pnpm export` produces it |
| 4 | Quality distribution histogram per corpus, drawn from committed scores | 4 | 5 | 5 | 100 | **BUILT** — histogram over committed weights |
| 5 | `/tasks` browser: every published task from `TaskRegistry`, with curator, share, fill | 4 | 5 | 5 | 100 | **SKIPPED** — one task exists, so a browser for it is a page with one row; `/corpus` already names its curator and share |
| 6 | Deep-linkable verification: `/verify?anchor=&leaf=&preimage=` so a reviewer can be *sent* a proof | 5 | 5 | 4 | 100 | **BUILT** — `?anchor=&leaf=&preimage=&proof=&go=1`, written on success |
| 7 | Provenance report per corpus: one page a buyer's counsel can read | 5 | 4 | 5 | 100 | **SKIPPED** — out of time this run; `/corpus` and `/verify` carry the same facts between them |
| 8 | Live log-head ticker in the nav, polling the chain | 3 | 5 | 4 | 60 | **SKIPPED** — `/verify` already shows the head; a second poller on every page is chattier than it is useful |
| 9 | Copy-to-clipboard on every hash and address, with confirmation | 3 | 5 | 4 | 60 | **BUILT** — copy with confirmation, and a fallback when clipboard is blocked |
| 10 | Empty states everywhere real: no corpora, no tasks, RPC unreachable | 4 | 5 | 4 | 80 | **BUILT** — loading, empty and RPC-unreachable states on `/corpus` |
| 11 | Episode inspector: decode any 197-byte preimage in the browser, field by field | 4 | 5 | 4 | 80 | **BUILT** — six decoded fields from the preimage itself |
| 12 | Anchor timeline on `/verify`: the log growing over blocks, as a drawn figure | 4 | 4 | 4 | 64 | **SKIPPED** — out of time; the anchor table already carries block numbers |
| 13 | Consent withdrawal surface: prove a key is live, and show when it stopped being | 4 | 4 | 4 | 64 | OPEN |
| 14 | Contributor earnings view keyed by address | 3 | 4 | 4 | 48 | OPEN |

## Tier 2 — worth building, lower down (rank 30–59)

| # | Idea | Rank | Status |
| --- | --- | --- | --- |
| 15 | Cap-table fan-out figure: one licence fee splitting to contributors, animated once on view | 48 | OPEN |
| 16 | `robots.txt` + `sitemap.xml` covering every route | 45 | **BUILT** — `robots.txt` + `sitemap.xml`, all 10 routes 200 |
| 17 | Per-page OG cards so a shared link previews correctly | 45 | OPEN |
| 18 | Skeleton/loading states for every chain read, instead of blank | 45 | **BUILT** — spinner while the market is read |
| 19 | RPC retry with backoff, and a visible "reconnecting" state | 44 | OPEN |
| 20 | Embodiment gallery: all 58 models with class, DoF and licence | 44 | **SKIPPED** — out of time; the registry is in `docs/EMBODIMENTS.md` and `embodiments.ts` |
| 21 | Licence-checker: which of the 58 models a buyer may ship commercially | 42 | OPEN |
| 22 | Keyboard shortcuts on `/verify` (⌘↵ submit, `s` sample, `e` episode) | 40 | **BUILT** — ⌘↵ / s / e, ignored while typing |
| 23 | `prefers-reduced-motion` honoured across every new figure | 40 | **BUILT** — every new figure honours reduced motion |
| 24 | Corpus diff: what changed between two anchors | 39 | OPEN |
| 25 | Task validator in the browser: paste a TaskSpec, see the errors | 38 | OPEN |
| 26 | Deterministic scene thumbnail per episode, from its seed | 38 | OPEN |
| 27 | Explorer links on every hash, address and block | 36 | **BUILT** — explorer links on the market and log |
| 28 | A `/status` page: chain height, log head, anchor lag, export freshness | 36 | OPEN |
| 29 | Anchor lag alarm: flag when the head has not been anchored in an hour | 35 | OPEN |
| 30 | Print stylesheet so the provenance report prints cleanly | 34 | OPEN |
| 31 | Corpus JSON API for programmatic buyers | 33 | OPEN |
| 32 | Search across tasks, corpora and leaves by hash prefix | 33 | OPEN |
| 33 | "How to verify this yourself" walkthrough with copy-paste commands | 32 | OPEN |
| 34 | Per-embodiment task counts, so the registry shows demand | 32 | OPEN |
| 35 | Dark/light honouring the OS, since the site is dark-only today | 31 | OPEN |
| 36 | Anchor cadence chart: intervals between anchors | 30 | OPEN |

## Tier 3 — real ideas, deliberately not now (rank 12–29)

37 Curator dashboard · 38 Contributor portfolio · 39 Leaderboard by quality not
volume · 40 Withdrawal UI for credited balances · 41 Corpus sample pack (free
first N episodes) · 42 Buyer receipt lookup by address · 43 Terms version
history · 44 Multi-corpus bundle pricing · 45 Referral attribution for curators
· 46 Task templates from LIBERO/RoboCasa shapes · 47 Predicate builder UI · 48
Range-authoring by dragging envelopes · 49 Live sampler preview with reroll · 50
Object/asset library browser · 51 MJCF viewer for any Menagerie model · 52 URDF
import · 53 Scene screenshot export · 54 Episode replay scrubber · 55 Trajectory
plot per episode · 56 Failure-mode tagging · 57 Duplicate/replay detection
surface · 58 Anti-cheat scoring · 59 Reviewer queue for disputed episodes · 60
Corpus quality certificate · 61 Signed export manifest · 62 IPFS mirror of
exports · 63 Arweave permanence option · 64 Multi-chain anchor mirroring · 65
EIP-712 typed consent signatures · 66 Passkey login for contributors · 67
Session keys for repeated submits · 68 Gasless submission via relayer · 69 USDC
pricing on the C-Chain · 70 Subscription licences · 71 Usage-metered licences ·
72 Per-episode micropayments · 73 Escrow for disputed corpora · 74 Curator
staking · 75 Slashing for bad task design · 76 Reputation from accepted rate ·
77 Task difficulty auto-calibration · 78 Coverage map across embodiments · 79
Scenario taxonomy · 80 Instruction-language linting · 81 Non-English
instructions · 82 Accessibility audit to WCAG AA · 83 Screen-reader pass on the
3D figures · 84 Reduced-data mode for slow links · 85 Service worker offline
shell · 86 Web vitals budget in CI · 87 Visual regression tests · 88 Contract
fuzzing in CI · 89 Slither/static analysis in CI · 90 Gas snapshot in CI · 91
Deployment provenance page · 92 Changelog from git history · 93 Public roadmap
page · 94 Investor one-pager route · 95 Press kit · 96 Demo video embed · 97
Interactive protocol diagram · 98 Cost model calculator · 99 Comparison table
against capture agencies · 100 "What this does not prove" page, stated plainly

## What I deliberately did not propose

Anything that fakes capture. A trajectory recorder, a simulator loop, or an
"episode replay" over synthetic payloads would all read as real data to a
reviewer and are not. Those wait for MuJoCo WASM and a real recorder; inventing
a plot from a hash would be the one thing that ends a diligence call.
