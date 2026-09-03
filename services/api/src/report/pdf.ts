/**
 * T-025 / T-041d — `?format=pdf` rendering. Behind a small `PdfRenderer`
 * interface so `report.test.ts` can run either way: `PlaywrightPdfRenderer`
 * is the production implementation (as of T-041d, `playwright` is present
 * in `node_modules` with a Chromium build fetched under
 * `~/.cache/ms-playwright`, so the PDF path is real and exercised by the
 * test suite when a browser launches), and `UnavailablePdfRenderer` is the
 * explicit fallback for a deployment or checkout where no browser is
 * available — never a silent no-op.
 *
 * `playwright` is imported dynamically (`import("playwright")`, not a
 * static import) so this file — and every route that imports it — loads
 * cleanly whether or not the package is present; a missing package or a
 * missing browser both surface as `PdfUnavailableError`, never a startup
 * crash.
 */

export class PdfUnavailableError extends Error {}

export interface PdfRenderer {
  /** Renders `html` (a complete document, e.g. from `render.ts`) to PDF bytes. Throws `PdfUnavailableError` if no PDF can be produced right now. */
  renderPdf(html: string): Promise<Uint8Array>;
}

/**
 * Headless-Chromium PDF rendering via Playwright. Launches a fresh browser
 * per call — reports are rare and not latency-sensitive enough to justify
 * keeping a browser process warm across requests, and a per-call launch
 * means one hung render can never wedge a shared instance for every other
 * request.
 */
export class PlaywrightPdfRenderer implements PdfRenderer {
  async renderPdf(html: string): Promise<Uint8Array> {
    let chromium: { launch: (opts?: unknown) => Promise<{ newPage: () => Promise<any>; close: () => Promise<void> }> };
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pw = (await import(/* @vite-ignore */ "playwright")) as { chromium: typeof chromium };
      chromium = pw.chromium;
    } catch {
      throw new PdfUnavailableError("the playwright package is not installed on this server");
    }

    let browser;
    try {
      // `--no-sandbox`/`--disable-gpu`/`--disable-dev-shm-usage` — the
      // sandbox is unavailable on this WSL image; without these, Chromium
      // launch hangs until Playwright's own timeout.
      browser = await chromium.launch({ args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
    } catch (e) {
      throw new PdfUnavailableError(
        `no Chromium browser is available for Playwright to launch (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    try {
      const page = await browser.newPage() as {
        setContent: (html: string, opts?: unknown) => Promise<void>;
        evaluate: (fn: () => unknown) => Promise<unknown>;
        pdf: (opts?: unknown) => Promise<Uint8Array>;
      };
      await page.setContent(html, { waitUntil: "load" });
      // The template pulls IBM Plex from Google Fonts (render.ts file
      // header) — `waitUntil: "load"` alone can race the webfont request,
      // so give `document.fonts.ready` a few seconds; if the font never
      // arrives (no network, slow CDN) the page still prints correctly on
      // its declared system-font fallback rather than hanging forever.
      await Promise.race([page.evaluate(() => (globalThis as any).document.fonts.ready), new Promise((r) => setTimeout(r, 4000))]);
      // `preferCSSPageSize` — honour the template's own `@page { size: A4;
      // margin: 18mm 16mm }` (docs/DESIGN.md §4) instead of Playwright's
      // zero-margin default, which would collide with the running footer.
      const pdf = await page.pdf({ format: "A4", printBackground: true, preferCSSPageSize: true });
      return pdf;
    } finally {
      await browser.close();
    }
  }
}

/** A `PdfRenderer` that always reports unavailable — for tests/deployments that never serve PDFs. */
export class UnavailablePdfRenderer implements PdfRenderer {
  async renderPdf(): Promise<Uint8Array> {
    throw new PdfUnavailableError("PDF rendering is not configured on this server");
  }
}
