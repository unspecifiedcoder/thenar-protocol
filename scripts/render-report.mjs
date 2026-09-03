#!/usr/bin/env node
// --experimental-strip-types
/**
 * `scripts/render-report.mjs` — T-041d demo tool: renders a Report v1 JSON
 * file (PLAN §9.6) through `services/api/src/report/render.ts` to a
 * self-contained HTML document, and optionally through
 * `services/api/src/report/pdf.ts`'s `PlaywrightPdfRenderer` to a PDF.
 * Used to produce `apps/web/samples/golden-report.{html,pdf}` from
 * `apps/web/samples/golden-report.json`, and generally for anyone who
 * wants to eyeball a report outside a running API server.
 *
 * Usage:
 *   npx tsx scripts/render-report.mjs <report.json> <out.html> [out.pdf] [--report-url <url>]
 *
 * `--report-url` is the `?report=` target embedded in the "verify this
 * report" box; defaults to `${PUBLIC_BASE_URL}/v1/corpora/{id}/report`
 * (`PUBLIC_BASE_URL` env var, else `https://thenar.io` — never a
 * `.example` placeholder host, since a report this script produces is
 * meant to be openable for real), except when `report.json`'s basename is
 * literally `golden-report.json` — the committed sample under
 * `apps/web/samples/` — where it defaults to the relative path
 * `/samples/golden-report.json`, so the checked-in sample points at
 * itself rather than at a server nobody is running.
 *
 * Exit 0 on success; exit 1 with a message on stderr if the report JSON
 * cannot be read/parsed, or if a PDF path was requested but Playwright's
 * Chromium is unavailable (the HTML is still written in that case).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";

import { renderReportHtml } from "../services/api/src/report/render.ts";
import { PlaywrightPdfRenderer, PdfUnavailableError } from "../services/api/src/report/pdf.ts";

async function main() {
  const args = process.argv.slice(2);
  const flagIdx = args.indexOf("--report-url");
  const explicitReportUrl = flagIdx >= 0 ? args[flagIdx + 1] : undefined;
  const positional = flagIdx >= 0 ? [...args.slice(0, flagIdx), ...args.slice(flagIdx + 2)] : args;
  const [reportPath, outHtmlPath, outPdfPath] = positional;
  if (!reportPath || !outHtmlPath) {
    console.error("usage: render-report.mjs <report.json> <out.html> [out.pdf] [--report-url <url>]");
    process.exit(1);
  }

  let report;
  try {
    report = JSON.parse(readFileSync(resolve(reportPath), "utf8"));
  } catch (e) {
    console.error(`could not read/parse ${reportPath}: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
    return;
  }

  const publicBaseUrl = process.env.PUBLIC_BASE_URL || "https://thenar.io";
  const reportJsonUrl = explicitReportUrl
    ?? (basename(reportPath) === "golden-report.json"
      ? "/samples/golden-report.json"
      : `${publicBaseUrl}/v1/corpora/${report.corpus?.id ?? "unknown"}/report`);

  const html = renderReportHtml(report, { reportJsonUrl });
  writeFileSync(resolve(outHtmlPath), html, "utf8");
  console.log(`wrote ${outHtmlPath} (${html.length} bytes)`);

  if (!outPdfPath) return;

  const renderer = new PlaywrightPdfRenderer();
  try {
    const pdf = await renderer.renderPdf(html);
    writeFileSync(resolve(outPdfPath), pdf);
    console.log(`wrote ${outPdfPath} (${pdf.length} bytes)`);
  } catch (e) {
    if (e instanceof PdfUnavailableError) {
      console.error(`PDF rendering unavailable, skipped: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
}

main();
