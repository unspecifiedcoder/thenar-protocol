#!/usr/bin/env node
/**
 * Record the judge walkthrough (docs/DEMO-SCRIPT.md) as a video.
 *
 *   pnpm demo:record            # writes docs/demo/thenar-demo.webm
 *   BASE=http://127.0.0.1:8080  # site to record (default)
 *
 * Every beat navigates to a page (or the pre-rendered terminal transcript),
 * injects the caption bar from design.css, holds for `hold` ms, and moves on.
 * Nothing on screen is fabricated: pages read the live chain; terminal beats
 * show the transcript of the real Fuji run (apps/web/samples/demo-transcript.html).
 */
import { chromium } from "playwright";
import { mkdirSync, readdirSync, renameSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

const BASE = process.env.BASE ?? "http://127.0.0.1:8080";
const OUT_DIR = "docs/demo";
const HOLD = Number(process.env.HOLD_MS ?? 14000);

const beats = [
  { url: "/index.html", caption: "Provenance and rights for physical-AI data.", scrollTo: 0 },
  { url: "/index.html", caption: "Every anchor here was read from Avalanche Fuji a moment ago. Nothing is drawn that the chain did not say.", scrollTo: ".window" },
  { url: "/index.html", caption: "Four badges. Each says exactly what it proves — and what it does not.", scrollTo: ".badges" },
  { url: "/index.html", caption: "Source is declared by the signer. It becomes “attested” only with a hardware-attested robot controller.", scrollTo: ".source" },
  { url: "/samples/demo-transcript.html#step-1", caption: "Ingest a real LeRobot dataset. Every episode gets a leaf, a signed receipt, and its checks." },
  { url: "/samples/demo-transcript.html#step-3", caption: "Anchored on Avalanche Fuji, block 58154513. Same root on the mirror." },
  { url: "/corpus.html", caption: "A corpus is its own Merkle tree, logged as a leaf. Selling it needs a proof, not our word.", scrollTo: ".register" },
  { url: "/samples/demo-transcript.html#step-5", caption: "The licence receipt names the terms hash, the corpus root and the manifest hash. Payment and terms in one call." },
  { url: "/verify.html?report=/samples/golden-report.json", caption: "The buyer verifies offline: file hashes, manifest, inclusion, consistency, consent, claims, corpus. Seven steps, no THENAR server.", scrollTo: ".steps", wait: 6000 },
  { url: "/samples/demo-transcript.html#step-7", caption: "A contributor withdraws consent. The head re-anchors at the same size with a new revocation root." },
  { url: "/samples/golden-report.html#limitations", caption: "The report ends with what it does not prove. Verbatim, every time." },
  { url: "/samples/demo-transcript.html#step-8", caption: "One byte flipped. The verifier names the file and the leaf." },
  { url: "/index.html", caption: "Live on Avalanche Fuji. 176 contract tests. Open source.", scrollTo: ".reg-footer" },
];

mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch({ args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: OUT_DIR, size: { width: 1440, height: 900 } },
  reducedMotion: "no-preference",
});
const page = await context.newPage();

for (const [i, b] of beats.entries()) {
  await page.goto(BASE + b.url, { waitUntil: "networkidle" }).catch(() => page.goto(BASE + b.url));
  if (b.wait) await page.waitForTimeout(b.wait);
  if (typeof b.scrollTo === "string") {
    await page.evaluate((sel) => document.querySelector(sel)?.scrollIntoView({ block: "start", behavior: "instant" }), b.scrollTo);
  } else if (typeof b.scrollTo === "number") {
    await page.evaluate((y) => window.scrollTo(0, y), b.scrollTo);
  }
  await page.evaluate(({ text, n, total }) => {
    document.querySelector(".caption")?.remove();
    const el = document.createElement("div");
    el.className = "caption";
    el.innerHTML = `<span style="opacity:.6;font-family:var(--mono,monospace);font-size:13px;margin-right:16px">${n}/${total}</span>${text}`;
    document.body.appendChild(el);
  }, { text: b.caption, n: i + 1, total: beats.length });
  console.log(`beat ${i + 1}/${beats.length} — ${b.caption}`);
  await page.waitForTimeout(HOLD);
}

await context.close();
await browser.close();

// Playwright names the file by a random id; rename to the deliverable.
const webm = readdirSync(OUT_DIR).filter((f) => f.endsWith(".webm") && f !== "thenar-demo.webm").sort().pop();
if (webm) renameSync(`${OUT_DIR}/${webm}`, `${OUT_DIR}/thenar-demo.webm`);
console.log(`wrote ${OUT_DIR}/thenar-demo.webm`);
try {
  execSync("ffmpeg -version", { stdio: "ignore" });
  execSync(`ffmpeg -y -i ${OUT_DIR}/thenar-demo.webm -c:v libx264 -pix_fmt yuv420p -movflags +faststart ${OUT_DIR}/thenar-demo.mp4`, { stdio: "inherit" });
  console.log(`wrote ${OUT_DIR}/thenar-demo.mp4`);
} catch { console.log("ffmpeg not available — webm only"); }
if (!existsSync(`${OUT_DIR}/thenar-demo.webm`)) process.exit(1);
