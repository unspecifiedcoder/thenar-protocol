/**
 * T-025 — renders a built Report v1 object (`report/build.ts`) into the
 * `templates/report.html` template. Pure string substitution — every value
 * placed into the page already exists on the report object; nothing here
 * computes or re-derives anything (I-11). Also the input Playwright PDF
 * rendering (`report/pdf.ts`) runs against.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { buildReport } from "./build.ts";

export type Report = ReturnType<typeof buildReport>;

const TEMPLATE_PATH = fileURLToPath(new URL("../../templates/report.html", import.meta.url));

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

function episodeRow(ep: Report["episodes"][number]): string {
  const badges = ep.badges.map((b) => `<span class="badge">${esc(b)}</span>`).join(" ");
  const wording = ep.wording.map((w) => `<div>${esc(w)}</div>`).join("");
  const consentLine = ep.consent.status === "revoked"
    ? `<span class="revoked">revoked${ep.consent.onset ? ` (onset block ${esc(ep.consent.onset.block)})` : ""}</span>`
    : "live";
  return `<tr>
    <td>${esc(ep.log_index)}</td>
    <td class="mono">${esc(ep.leaf)}</td>
    <td>${badges}</td>
    <td>${wording}</td>
    <td>${consentLine}</td>
  </tr>`;
}

function checkRow(row: Report["checks_run"][number]): string {
  return `<tr>
    <td>${esc(row.check)}</td>
    <td>${esc(row.check_version)}</td>
    <td class="mono">${esc(JSON.stringify(row.thresholds))}</td>
  </tr>`;
}

export type RenderReportOpts = {
  /** Base URL of the static `/verify` page; the report's own JSON is appended as `?report=`. Defaults to a relative link. */
  verifyBaseUrl?: string;
  /** Base URL of this API (used to build the `?report=` target for `verifyBaseUrl`, e.g. `GET /v1/corpora/{id}/report`). */
  reportJsonUrl?: string;
};

/** Renders `report` into the `templates/report.html` template; returns the finished HTML document. */
export function renderReportHtml(report: Report, opts: RenderReportOpts = {}): string {
  const template = readFileSync(TEMPLATE_PATH, "utf8");
  const verifyBase = opts.verifyBaseUrl ?? "/verify";
  const verifyUrl = opts.reportJsonUrl ? `${verifyBase}?report=${encodeURIComponent(opts.reportJsonUrl)}` : `${verifyBase}?report_id=${encodeURIComponent(report.report_id)}`;

  const replacements: Record<string, string> = {
    REPORT_ID: esc(report.report_id),
    GENERATED_AT: esc(isoTime(report.generated_at)),
    OPERATOR_NAME: esc(report.operator.name),
    DRAFT_BADGE: report.corpus.draft ? '<span class="draft">draft — not yet logged/sealed</span>' : "",
    CORPUS_ID: esc(report.corpus.id),
    CORPUS_MANIFEST_HASH: esc(report.corpus.manifest_hash),
    CORPUS_ROOT: esc(report.corpus.corpus_root),
    EPISODE_COUNT: esc(report.corpus.episode_count),
    TERMS_HASH: esc(report.corpus.terms.hash),
    CONTAINS_REVOKED: report.corpus.contains_revoked ? '<span class="revoked">yes</span>' : "no",
    ANCHOR_ROOT: esc(report.anchor.root),
    ANCHOR_SIZE: esc(report.anchor.size),
    ANCHOR_REVOCATION_ROOT: esc(report.anchor.revocation_root),
    EPISODES_ROWS: report.episodes.map(episodeRow).join("\n"),
    CHECKS_ROWS: report.checks_run.map(checkRow).join("\n"),
    LIMITATIONS_ITEMS: report.limitations.map((l) => `<li>${esc(l)}</li>`).join("\n"),
    VERIFY_URL: esc(verifyUrl),
    REPORT_HASH: esc(report.report_hash),
  };

  let html = template;
  for (const [key, value] of Object.entries(replacements)) {
    html = html.split(`{{${key}}}`).join(value);
  }
  return html;
}
