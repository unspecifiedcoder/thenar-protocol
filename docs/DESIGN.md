# THENAR design system — "the register"

Normative for `/`, `/verify`, `/corpus`, the Provenance Report (HTML + PDF)
and the demo recording. Implementation agents follow this file and
`apps/web/design.css`; they do not invent tokens, faces or motion.

## 1. The subject, the audience, the job

THENAR issues **records** about machine experience: what a dataset is, where
it came from, who may train on it, whether that is still true. The audience
is an ML lead deciding whether to pay for data, their counsel, and — this
week — judges watching a five-minute walkthrough. The page's one job is to
make *"you can check this yourself"* visible: every claim sits next to the
evidence for it and the exact wording of what it does not prove.

The design language is a **register** — the ledger a registrar keeps: cool
paper, navy ink, rules that mean something, a seal on what has been anchored,
and a typewriter face for anything that is a hash. Live chain state appears
in one dark "instrument window"; everything issued to a person is paper.

This is deliberately not the crypto dashboard (black + neon), not the SaaS
card kit, and not the warm-cream-and-serif page. Those are defaults; this
subject has its own vernacular — notary, registry, certificate — and we use it.

## 2. Tokens (`apps/web/design.css` is the source of truth)

| Token | Value | Role |
| --- | --- | --- |
| `--paper` | `#F1F2F4` | page ground (cool, not cream) |
| `--paper-2` | `#E7E9ED` | inset panels, table stripes |
| `--ink` | `#0F1B2D` | text, rules that matter |
| `--ink-2` | `#4A5567` | secondary text |
| `--rule` | `#C7CCD4` | hairlines |
| `--seal` | `#1F3A93` | the one accent: anchored, links, focus |
| `--ok` | `#157F6D` | pass / attested |
| `--warn` | `#B7791F` | declared / inconclusive / pending |
| `--fail` | `#B3261E` | fail / revoked |
| `--window` | `#0B1220` | the single dark surface (live ledger) |
| `--window-fg` | `#DCE3F0` | text on the window |

Faces: **IBM Plex Sans** (400/500/600) for everything read; **IBM Plex Mono**
(400/500) for hashes, proofs, addresses, calldata — data that a person may
copy. No third face. No italics for emphasis. Weight 600 is the maximum.

Type scale (px / line): 13/20 small · 15/24 body · 17/26 lead · 22/30 h3 ·
30/38 h2 · 44/50 h1 (desktop) · 34/40 h1 (mobile). Measure ≤ 68ch.

Spacing: 4-based; section rhythm 64 (desktop) / 40 (mobile). Content width
1120; the register grid is 12 columns with a 3-column **margin column** on
the right for annotations ("what this proves / does not prove"). Left-aligned
throughout; nothing centred except the seal on the report cover.

Radius: 2px on inputs and buttons, 0 on tables and panels, full-round only on
the seal. Shadows: none. Borders carry meaning — a 1px `--rule` separates
rows; a 2px `--ink` rule opens a section; a 3px `--seal` left rule marks a
row that is anchored.

Motion: one orchestrated moment per page — the ledger tape draws its anchors
left-to-right on load (600 ms, `cubic-bezier(.2,.7,.2,1)`), then stays still.
Interactions answer the person: a copied hash shows "Copied" inline for 1.2 s;
a verification step flips its status mark; nothing hovers, floats or fades in
on scroll. `prefers-reduced-motion` disables the tape draw.

## 3. Components (all in `design.css`, class names fixed)

- `.reg-nav` — one line: wordmark "THENAR" (Plex Sans 600, letter-spacing 0),
  links `Verify · Corpora · Protocol · Company` as plain text, a right-side
  chain chip `.chip-chain` reading the live chain name from `chains.js`.
- `.tape` — the **ledger tape** (the memorable element): a horizontal strip of
  anchors read live from `GraspLog`, each a paper "stub" with `size`, short
  root and block; the head carries the seal; a withdrawal-carrying anchor has
  a `--warn` notch. Sits in the dark `.window`. Never draws invented stubs;
  if the RPC fails the window says so in `--window-fg` at 60 %.
- `.seal` — a 44px circular mark: ring in `--seal`, "anchored" set around the
  ring in 9px Plex Mono caps (the only caps on the site), a check glyph
  inside. Used on the tape head, on anchored rows, on the report cover.
- `.badge` — the four evidence badges: `.badge-l0 … .badge-l3`. A badge is a
  short rectangular stamp: 2px `--ink` border, label in Plex Sans 600 13px,
  the level number set in Plex Mono at the left edge. Unearned badges are
  drawn in `--rule` outline with no label fill. Wording lines from
  `wording.js` render beneath in 15/24 `--ink-2`.
- `.source` — the source line: a small `--warn` square for "declared", a
  `--ok` square for "attested", then the verbatim wording.
- `.hash` — Plex Mono 13px, `--ink`, `overflow-wrap:anywhere`; middle-
  truncated variant `.hash-short` shows first 10 and last 6 with a copy
  affordance that reads "Copy" then "Copied".
- `.register` — the table: 2px `--ink` top rule, 1px `--rule` row lines,
  header in Plex Sans 500 13px `--ink-2`, no zebra unless > 12 rows.
- `.steps` — the verification checklist: each step a row `status | name |
  evidence`; status is a 16px square: `--ok` filled with a check, `--fail`
  filled with a cross, `--warn` outline for skipped/inconclusive.
- `.marginalia` — right-column notes in 13/20 `--ink-2` with a 1px `--rule`
  left border; used for "what this proves / does not prove".
- `.window` — the dark instrument surface: `--window` ground, 1px inset border
  `#22304A`, Plex Mono for numbers.
- Buttons: `.btn` filled `--ink` on paper, `.btn-seal` filled `--seal`,
  `.btn-quiet` outlined. Text is the action: "Check against the chain",
  "Copy calldata", "Download report".

## 4. Pages

### `/` — the register's cover
```
┌ nav ─────────────────────────────────────────────── chain chip ┐
│ h1  Provenance and rights for physical-AI data.                 │
│ lead A public register of what a robot dataset is, where it     │
│      came from, who may train on it, and whether that is still  │
│      true — checkable by anyone, without trusting THENAR.       │
│ [Check a record]  [Read a report]                               │
├ window ── the ledger tape, live from the chain ─────────────────┤
│ ▭ 24  ▭ 48 ◉ 55(withdrawal) …                    head ◎ anchored│
├────────────────────────────────────────────────────┬────────────┤
│ What a report answers (4 questions, each with the  │ marginalia │
│ evidence that answers it)                          │ what this  │
│ The four badges, as stamps, with verbatim wording  │ does not   │
│ The source line, declared vs attested              │ prove      │
│ One episode, end to end (a real row from the demo) │            │
│ Known limitations (verbatim PLAN §22)              │            │
└ footer: addresses in .hash, "Lab" link, terms ─────┴────────────┘
```
Hero copy is the tagline; no stats row, no gradient, no three-column
feature cards. The tape is the hero image.

### `/verify` — the instrument
Left: one form with three modes as plain tabs (Record · Report · Corpus),
chain selector and RPC field in the `.window` header showing which chain
answered. Right: `.steps` checklist that fills as steps run, then the badges
and source line for the record, then the raw evidence in `.hash` blocks.
Failing step names itself; the summary line only reads "Every step passed"
when every step passed.

### `/corpus` — the register and the record card
List: `.register` of corpora (title, episodes, sources, price, sealed/anchored
seal). Detail: a record card — corpus manifest hash, corpus root, terms hash
(link), price/token, `Sources —` line, contains-revoked flag, the buyer flow:
a checkbox "I have read terms {hash}" then the exact calldata in `.hash`
blocks with "Copy calldata"; optional wallet button "License with wallet".

### Provenance Report (HTML template → PDF, A4)
Cover: seal centred, "Provenance Report", corpus title, corpus manifest hash,
report hash, anchor `(root, size)` with chain locators, generated-at, QR to
`/verify?report=`. Page 2: summary register — episodes by badge set, sources
line, receipts. Then one register row per episode (leaf, index, badges,
source, claims with thresholds, consent status). Final page: "What this
report does not prove" — PLAN §22 verbatim — and the verification procedure.
Running footer: report hash short + page n/N. Print-safe: no dark surfaces.

## 5. Copy rules
Sentence case. Verbs on buttons. Badge and source wording verbatim from
`wording.js`. Never "authentic", "genuine", "real", "verified" (outside the
L3 template), "independent". "physical" only with "declared"/"attested" on
the same line. Empty states say what to do next ("No corpora sealed yet —
seal one with `scripts/seal-corpus.mjs`").

## 6. Recording
1440×900, Chromium via Playwright `recordVideo`, captions injected as a
`.caption` bar (paper on ink, Plex Sans 17px) at the bottom of the viewport;
one caption per demo step; the script is `docs/DEMO-SCRIPT.md`.
