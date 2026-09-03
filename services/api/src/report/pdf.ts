/**
 * T-025 — `?format=pdf` rendering. Behind a small `PdfRenderer` interface
 * so `report.test.ts` never needs a real browser: the interface is what
 * `routes/corpora.ts` depends on, `PlaywrightPdfRenderer` is the only
 * production implementation, and the test suite exercises the HTML
 * template (`render.ts`) directly instead of rasterising it (per this
 * task's supervisor note — this checkout has Chromium fetched under
 * `~/.cache/ms-playwright` but the `playwright` npm package itself is not
 * installed, and installing dependencies is out of scope/forbidden here).
 *
 * `playwright` is imported dynamically (`import("playwright")`, not a
 * static import) specifically so this file — and every route that imports
 * it — loads cleanly whether or not the package is present; a missing
 * package or a missing browser both surface as `PdfUnavailableError`,
 * never a startup crash.
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
      browser = await chromium.launch();
    } catch (e) {
      throw new PdfUnavailableError(
        `no Chromium browser is available for Playwright to launch (${e instanceof Error ? e.message : String(e)})`,
      );
    }
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "load" });
      const pdf = (await page.pdf({ format: "A4", printBackground: true })) as Uint8Array;
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
