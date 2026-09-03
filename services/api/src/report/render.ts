/**
 * T-041d — renders a built Report v1 object (`report/build.ts`) into the
 * `templates/report.html` template as a finished, self-contained,
 * print-ready A4 document (PLAN §9.6, §13; `docs/DESIGN.md` §4
 * "Provenance Report"). Pure string assembly — every value placed into the
 * page already exists on the report object; nothing here computes or
 * re-derives a proof (I-11). This is also the input Playwright PDF
 * rendering (`report/pdf.ts`) runs against, so the document must be fully
 * self-contained (fonts via a Google Fonts `<link>` with system
 * fallbacks; the seal is inline SVG; there is no external stylesheet or
 * script) and deterministic — the only wall-clock value on the page is
 * `generated_at`, which is itself a report field, not `Date.now()`.
 *
 * Badge/source wording is never invented here: badge strings, wording
 * lines and `source` are read verbatim off each episode exactly as
 * `report/build.ts` (via `badges.ts`/`wording.ts`) produced them — this
 * file only decides layout, not what a line says — except the corpus-level
 * "Sources —" rollup line, which is *computed* by calling
 * `corpusSourcesWording` from `packages/protocol/src/wording.ts` itself
 * (the same function `apps/web` uses), so that line is still the
 * protocol's own verbatim template, not a re-invention of it.
 *
 * QR code: PLAN/DESIGN call for a QR to `/verify?report=`. This build
 * renders that as a bordered box carrying the verify URL as text plus a
 * short instruction, rather than a scannable QR symbol — a dependency-free
 * from-scratch QR encoder (Reed-Solomon ECC, version/mask selection) was
 * judged too large a surface to add correctly under this task's "no new
 * dependencies" constraint without real risk of shipping a QR that *looks*
 * right but does not scan, which would be worse than not having one. This
 * is the fallback the task text names as acceptable; the URL is still
 * fully present and clickable in the HTML render.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { buildReport } from "./build.ts";
import { corpusSourcesWording, type Source } from "../../../../packages/protocol/src/wording.ts";

export type Report = ReturnType<typeof buildReport>;
type Episode = Report["episodes"][number];
type ChainRow = Report["anchor"]["chains"][number];

const TEMPLATE_PATH = fileURLToPath(new URL("../../templates/report.html", import.meta.url));

const LEVEL_LABELS: Record<string, string> = { L0: "Committed", L1: "Signed", L2: "Attested", L3: "Checked" };
const ALL_LEVELS = ["L0", "L1", "L2", "L3"] as const;

/** HTML-escapes `s` — every placeholder value in the template is untrusted text (an org's own title, a check's summary, …). */
function esc(s: unknown): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isoTime(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString();
}

/** First 10 + last 6 chars, matching `apps/web/corpus.js`'s `.hash-short` convention. */
function short(h: string): string {
  return h.length > 18 ? `${h.slice(0, 10)}…${h.slice(-6)}` : h;
}

function chainLocator(ch: ChainRow): string {
  return `chain ${esc(ch.chain_id)} · block ${esc(ch.block_number)} · tx ${esc(short(ch.tx))}`;
}

function badgeStamps(earned: readonly string[]): string {
  return ALL_LEVELS
    .map((lvl) => {
      const on = earned.includes(lvl);
      return `<span class="badge${on ? "" : " off"}"><span class="lvl">${lvl}</span><span class="lbl">${esc(LEVEL_LABELS[lvl])}</span></span>`;
    })
    .join("");
}

/** True iff `wording` carries the L3-source-axis "attested physical capture" line (PLAN §1.1); read off already-rendered text, never re-derived. */
function isAttestedFromWording(wording: readonly string[]): boolean {
  return wording.some((w) => w.startsWith("Source — attested"));
}

function sourceLine(ep: Episode): string {
  const line = ep.wording.find((w) => w.startsWith("Source —")) ?? `Source — declared by the signer: ${esc(ep.source)}. Not attested.`;
  const attested = isAttestedFromWording(ep.wording);
  return `<div class="source" data-attested="${attested ? "1" : "0"}">${esc(line)}</div>`;
}

function claimsTable(ep: Episode): string {
  if (ep.claims.length === 0) return `<p class="empty-note">No verification claims recorded for this episode.</p>`;
  const rows = ep.claims
    .map(
      (c) => `<tr>
        <td>${esc(c.check)}</td>
        <td class="result-${esc(c.result)}">${esc(c.result)}</td>
        <td class="mono">${esc(JSON.stringify((c.detail as { thresholds?: unknown })?.thresholds ?? {}))}</td>
        <td class="mono">${c.log_index === null ? "—" : esc(c.log_index)}</td>
      </tr>`,
    )
    .join("\n");
  return `<table class="register claims">
    <thead><tr><th>Check</th><th>Result</th><th>Thresholds</th><th>Log index</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

function consentBlock(ep: Episode): string {
  const c = ep.consent;
  if (c.status === "revoked") {
    const onset = "onset" in c && c.onset ? ` — onset at block ${esc(c.onset.block)}` : "";
    return `<div class="consent"><span class="revoked">Revoked${onset}</span> <span class="mono">key ${esc(short(c.key))}</span></div>`;
  }
  return `<div class="consent">Live <span class="mono">key ${esc(short(c.key))}</span></div>`;
}

function filesList(ep: Episode): string {
  const rows = ep.files
    .map(
      (f) => `<tr>
        <td>${esc(f.path)}</td>
        <td class="num">${esc(f.bytes)}</td>
        <td class="mono">${esc(short(f.hash))}</td>
      </tr>`,
    )
    .join("\n");
  return `<table class="register files">
    <thead><tr><th>File</th><th>Bytes</th><th>Hash</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

/**
 * One register block per episode (DESIGN.md §4): leaf, log index, corpus
 * index, badge stamps, wording lines, source line, claims table, consent
 * status/onset, file list. Each block is one logical "page section" for
 * the running footer (see `renderReportHtml`); it may still overflow one
 * physical page for an episode with many files/claims, but starts on its
 * own page (`page-break-before: always`).
 */
function episodeSection(ep: Episode, pageNo: number, totalPages: number, reportHashShort: string): string {
  return `<section class="page episode-page">
    <header class="episode-head">
      <h2>Episode <span class="mono">#${esc(ep.log_index)}</span></h2>
      <div class="badges">${badgeStamps(ep.badges)}</div>
    </header>
    <table class="kv">
      <tr><th>Leaf</th><td class="mono hash">${esc(ep.leaf)}</td></tr>
      <tr><th>Log index</th><td>${esc(ep.log_index)}</td></tr>
      <tr><th>Corpus index</th><td>${esc(ep.corpus_index)}</td></tr>
      <tr><th>Manifest hash</th><td class="mono hash">${esc(ep.manifest_hash)}</td></tr>
      <tr><th>Payload hash</th><td class="mono hash">${esc(ep.payload_hash)}</td></tr>
    </table>
    <div class="wording">${ep.wording.map((w) => `<div>${esc(w)}</div>`).join("")}</div>
    ${sourceLine(ep)}
    <h3>Claims</h3>
    ${claimsTable(ep)}
    <h3>Consent</h3>
    ${consentBlock(ep)}
    <h3>Files</h3>
    ${filesList(ep)}
    ${footer(pageNo, totalPages, reportHashShort)}
  </section>`;
}

function footer(pageNo: number, totalPages: number, reportHashShort: string): string {
  return `<div class="reg-footer-print">
    <span class="mono">report ${esc(reportHashShort)}</span>
    <span class="page-no">page ${pageNo} of ${totalPages}</span>
  </div>`;
}

/** Groups episodes by their exact badge set (DESIGN.md §4 "episodes by badge set") and returns `[badgeSetLabel, count][]`, largest count first. */
function badgeSetSummary(episodes: readonly Episode[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const ep of episodes) {
    const key = [...ep.badges].sort().join(" + ") || "none";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function summaryRows(episodes: readonly Episode[]): string {
  return badgeSetSummary(episodes)
    .map(([label, n]) => `<tr><td>${esc(label)}</td><td class="num">${esc(n)}</td></tr>`)
    .join("\n");
}

function episodeIndexRows(episodes: readonly Episode[]): string {
  return episodes
    .map(
      (ep) => `<tr class="${ep.consent.status === "revoked" ? "anchored" : ""}">
        <td class="num">${esc(ep.log_index)}</td>
        <td>${ep.badges.map((b) => `<span class="badge inline"><span class="lvl">${esc(b)}</span></span>`).join(" ")}</td>
        <td>${esc(ep.source)}</td>
        <td>${ep.consent.status === "revoked" ? '<span class="revoked">revoked</span>' : "live"}</td>
        <td class="mono">${esc(short(ep.leaf))}</td>
      </tr>`,
    )
    .join("\n");
}

/** PLAN §10.10 — the seven-step verification procedure a third party runs (`scripts/verify-report.mjs`), copied verbatim. */
export const VERIFICATION_STEPS: readonly string[] = [
  "For each delivered file: H(fileBytes) equals files[].hash; rebuild payloadHash (§10.4) and compare.",
  "Recompute manifestHash; if signature present, verify per §10.6 against the org's published key valid at the leaf's first-anchor time.",
  "Rebuild the 0x02 preimage from §10.12 + submittedAt (delivered in report); leaf hash; inclusion against the report anchor (root,size) read from any chain carrying the log (indexOfRoot lookup).",
  "Consistency proof from the sealing anchor to the report anchor.",
  "Consent non-membership at the report anchor; if revoked, onset.",
  "Each claim leaf: inclusion; verifier signature over the claim; detailHash matches detail; thresholds present.",
  "Corpus inclusion against corpusRoot; corpus manifest leaf inclusion; corpusRoot/corpusManifestHash equal the on-chain corpus and receipt.",
];

function checksRunRows(report: Report): string {
  return report.checks_run
    .map(
      (row) => `<tr>
        <td>${esc(row.check)}</td>
        <td class="mono">${esc(row.check_version)}</td>
        <td class="mono">${esc(JSON.stringify(row.thresholds))}</td>
      </tr>`,
    )
    .join("\n");
}

/** `corpus.on_chain` (PLAN §9.6) — `build.ts` never populates it today (I-11: not fabricated), but the field's shape is normative, so render it if a future producer of Report v1 fills it in. */
function onChainLine(onChain: { chain_id: number; registry: string; corpus_id: string; tx: string } | null): string {
  if (!onChain) return "not recorded on chain";
  return `<span class="mono">chain ${esc(onChain.chain_id)} · registry ${esc(short(onChain.registry))} · corpus_id ${esc(onChain.corpus_id)} · tx ${esc(short(onChain.tx))}</span>`;
}

function receiptsBlock(report: Report): string {
  if (report.receipts.length === 0) return `<p class="empty-note">No append receipts recorded on this report.</p>`;
  const rows = (report.receipts as { leaf_hash?: string; leaf_index?: number; log_size_after?: number }[])
    .map(
      (r) => `<tr>
        <td class="mono">${esc(short(String(r.leaf_hash ?? "")))}</td>
        <td class="num">${esc(r.leaf_index ?? "—")}</td>
        <td class="num">${esc(r.log_size_after ?? "—")}</td>
      </tr>`,
    )
    .join("\n");
  return `<table class="register"><thead><tr><th>Leaf</th><th>Index</th><th>Log size after</th></tr></thead><tbody>${rows}</tbody></table>`;
}

export type RenderReportOpts = {
  /** Base URL of the static `/verify` page; the report's own JSON is appended as `?report=`. Defaults to a relative link. */
  verifyBaseUrl?: string;
  /** Base URL of this API (used to build the `?report=` target for `verifyBaseUrl`, e.g. `GET /v1/corpora/{id}/report`). */
  reportJsonUrl?: string;
};

/** Renders `report` into the `templates/report.html` template; returns the finished, self-contained A4 HTML document. */
export function renderReportHtml(report: Report, opts: RenderReportOpts = {}): string {
  const template = readFileSync(TEMPLATE_PATH, "utf8");
  const verifyBase = opts.verifyBaseUrl ?? "/verify";
  const verifyUrl = opts.reportJsonUrl
    ? `${verifyBase}?report=${encodeURIComponent(opts.reportJsonUrl)}`
    : `${verifyBase}?report_id=${encodeURIComponent(report.report_id)}`;

  const reportHashShort = short(report.report_hash);
  // Logical "page sections" for the running footer: cover, summary, one per
  // episode, final (limitations + procedure). A section is expected to fit
  // one physical A4 page for a typical episode; the numbering is a
  // best-effort approximation of the printed page count, computed from the
  // document's own structure rather than from a physical-pagination signal
  // Chromium's print engine does not expose to page content (see file
  // header comment).
  const totalPages = 2 + report.episodes.length + 1;

  const attestedFlags = report.episodes.map((ep) => isAttestedFromWording(ep.wording));
  const sourcesLine = corpusSourcesWording(
    report.episodes.map((ep, i) => ({ source: ep.source as Source, attested: attestedFlags[i] })),
  );

  const episodeSections = report.episodes
    .map((ep, i) => episodeSection(ep, i + 3, totalPages, reportHashShort))
    .join("\n");

  const replacements: Record<string, string> = {
    REPORT_ID: esc(report.report_id),
    GENERATED_AT: esc(isoTime(report.generated_at)),
    OPERATOR_NAME: esc(report.operator.name),
    DRAFT_BADGE: report.corpus.draft ? '<span class="draft">draft — not yet logged/sealed</span>' : "",
    REPORT_KIND: esc(`v${report.v} ${report.kind}`),
    VERIFIER_KEY_ID: esc(report.operator.verifier_key_id),
    CORPUS_ID: esc(report.corpus.id),
    CORPUS_MANIFEST_HASH: esc(report.corpus.manifest_hash),
    CORPUS_ROOT: esc(report.corpus.corpus_root),
    EPISODE_COUNT: esc(report.corpus.episode_count),
    TERMS_HASH: esc(report.corpus.terms.hash),
    TERMS_URI: report.corpus.terms.uri ? `<a href="${esc(report.corpus.terms.uri)}">${esc(report.corpus.terms.uri)}</a>` : "not published",
    ON_CHAIN: onChainLine(report.corpus.on_chain as { chain_id: number; registry: string; corpus_id: string; tx: string } | null),
    CONTAINS_REVOKED: report.corpus.contains_revoked ? '<span class="revoked">yes</span>' : "no",
    ANCHOR_ROOT: esc(report.anchor.root),
    ANCHOR_SIZE: esc(report.anchor.size),
    ANCHOR_REVOCATION_ROOT: esc(report.anchor.revocation_root),
    ANCHOR_CHAINS: report.anchor.chains.map((ch) => `<div class="mono small">${chainLocator(ch)}</div>`).join(""),
    SEALING_NOTE: report.sealing_anchor
      ? `<p class="small">Sealing anchor <span class="mono">(root ${esc(short(report.sealing_anchor.root))}, size ${esc(report.sealing_anchor.size)})</span>${
          report.consistency_proof.length > 0
            ? ` — a ${esc(report.consistency_proof.length)}-node consistency proof carries it forward to the report anchor above.`
            : " — identical to the report anchor; no consistency proof needed."
        }</p>`
      : `<p class="small">This corpus is a draft: it has not yet been logged as a sealed 0x03 manifest leaf, so there is no separate sealing anchor.</p>`,
    VERIFY_URL: esc(verifyUrl),
    REPORT_HASH: esc(report.report_hash),
    REPORT_HASH_SHORT: esc(reportHashShort),
    SUMMARY_ROWS: summaryRows(report.episodes),
    SOURCES_LINE: esc(sourcesLine),
    RECEIPTS_BLOCK: receiptsBlock(report),
    CHECKS_ROWS: checksRunRows(report),
    EPISODE_INDEX_ROWS: episodeIndexRows(report.episodes),
    EPISODE_SECTIONS: episodeSections,
    LIMITATIONS_ITEMS: report.limitations.map((l) => `<li>${esc(l)}</li>`).join("\n"),
    VERIFICATION_STEPS: VERIFICATION_STEPS.map((s) => `<li>${esc(s)}</li>`).join("\n"),
    FOOTER_COVER: footer(1, totalPages, reportHashShort),
    FOOTER_SUMMARY: footer(2, totalPages, reportHashShort),
    FOOTER_FINAL: footer(totalPages, totalPages, reportHashShort),
  };

  let html = template;
  for (const [key, value] of Object.entries(replacements)) {
    html = html.split(`{{${key}}}`).join(value);
  }
  return html;
}
