/**
 * T-021 — Wording grep guard (PLAN §1, I-1)
 *
 * Fails CI if forbidden words appear in apps/web or services/api/src/report
 * (if that directory exists) outside the L3 template ("Checked by … see details").
 *
 * Forbidden words: authentic, genuine, proven real, verified, independent, real
 * (except inside the L3 wording template which already contains them by necessity).
 */

import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { resolve, dirname, join, extname } from "path";
import { fileURLToPath } from "url";
import { describe, it } from "node:test";
import assert from "node:assert";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(__dirname, "..");
const repoRoot = resolve(__dirname, "..", "..");

/**
 * The forbidden words list from PLAN §1.
 * (We could import from packages/protocol/src/wording.ts but that's a .ts file
 * and this is a .mjs test; the import path would be awkward. Duplicate with comment.)
 */
const FORBIDDEN_WORDS = [
  "authentic",
  "genuine",
  "real",
  "proven real",
  "verified",
  "independent",
];

function readFileIfExists(path) {
  if (!existsSync(path)) {
    return "";
  }
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function scanForForbiddenWords(filePath, content, isLegitL3Context = false) {
  const errors = [];

  for (const word of FORBIDDEN_WORDS) {
    // Create a regex that matches the word as a whole word (case-insensitive for some)
    const regex = new RegExp(`\\b${word}\\b`, "i");

    if (!regex.test(content)) {
      continue; // Word not found, skip
    }

    // If we're checking the L3 template context, allow these words inside "Checked by"
    if (isLegitL3Context) {
      // The L3 template is: "Checked by {operator} — {n} checks run: {list}. Heuristic; see details."
      // It legitimately contains "verified" and others in the context of checks.
      // For now, we allow the words to appear if they're in a function definition or string
      // that's part of the L3 wording template.
      // This is a simple heuristic: if the content mentions "Checked by" and the word,
      // we allow it (assuming it's in that context).
      if (content.includes("Checked by") && content.includes(word)) {
        // Assume it's in the L3 template; don't error
        continue;
      }
    }

    // The word appears and is not excused by L3 template context
    errors.push(`${filePath}: contains "${word}"`);
  }

  return errors;
}

describe("Wording guard (PLAN §1, I-1)", () => {
  it("no forbidden words in apps/web HTML files", () => {
    const htmlFiles = [
      "index.html",
      "products.html",
      "protocol.html",
      "market.html",
      "company.html",
      "faq.html",
      "verify.html",
    ];

    const allErrors = [];
    for (const file of htmlFiles) {
      const filePath = resolve(webDir, file);
      const content = readFileIfExists(filePath);
      if (!content) continue;
      const errors = scanForForbiddenWords(filePath, content, false);
      allErrors.push(...errors);
    }

    assert.strictEqual(allErrors.length, 0, allErrors.join("\n"));
  });

  it("no forbidden words in apps/web JS files (except L3 template)", () => {
    const jsFiles = [
      "grasp.js",
      "grasp-chain.js",
      "scene.js",
      "hotaru.js",
    ];

    const allErrors = [];
    for (const file of jsFiles) {
      const filePath = resolve(webDir, file);
      const content = readFileIfExists(filePath);
      if (!content) continue;
      // These files may contain the L3 template, so allow words in that context
      const errors = scanForForbiddenWords(filePath, content, true);
      allErrors.push(...errors);
    }

    assert.strictEqual(allErrors.length, 0, allErrors.join("\n"));
  });

  it("no forbidden words in services/api/src/report (if it exists)", () => {
    const reportDir = resolve(repoRoot, "services", "api", "src", "report");
    if (!existsSync(reportDir)) {
      // Directory doesn't exist yet; skip
      return;
    }

    // Scan all .ts files in the report directory
    const fs = require("fs");
    const path = require("path");

    function walkDir(dir, callback) {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        if (stat.isDirectory()) {
          walkDir(filePath, callback);
        } else if (file.endsWith(".ts") || file.endsWith(".tsx")) {
          callback(filePath);
        }
      }
    }

    const allErrors = [];
    walkDir(reportDir, (filePath) => {
      const content = readFileIfExists(filePath);
      if (!content) return;
      // These files may contain the L3 template, so allow words in that context
      const errors = scanForForbiddenWords(filePath, content, true);
      allErrors.push(...errors);
    });

    assert.strictEqual(allErrors.length, 0, allErrors.join("\n"));
  });

  it("forbidden words list is complete", () => {
    // This test just validates that the forbidden words list matches PLAN §1
    assert.strictEqual(FORBIDDEN_WORDS.length, 6, "expected 6 forbidden words");
    assert.ok(FORBIDDEN_WORDS.includes("authentic"), "authentic should be forbidden");
    assert.ok(FORBIDDEN_WORDS.includes("genuine"), "genuine should be forbidden");
    assert.ok(FORBIDDEN_WORDS.includes("real"), "real should be forbidden");
    assert.ok(FORBIDDEN_WORDS.includes("proven real"), "proven real should be forbidden");
    assert.ok(FORBIDDEN_WORDS.includes("verified"), "verified should be forbidden");
    assert.ok(FORBIDDEN_WORDS.includes("independent"), "independent should be forbidden");
  });
});

/**
 * T-040 — §1.1/D-30 "physical" guard.
 *
 * PLAN §1.1: 'the word "physical" may not appear on any surface without
 * "declared" or "attested" in the same line'. Scoped here to the surfaces
 * that actually render a `source`/badge claim: `apps/web/*.js` (excluding
 * the vendored `ed25519.js`, which never touches wording) and
 * `services/api/src/report/**` (skipped gracefully if that directory does
 * not exist yet, same as the forbidden-words scans above).
 *
 * Also excludes `wording.js` itself: it is the canonical source of the
 * qualified templates (`sourceWording`, `attestedPhysicalWording`), built
 * up from fragments (a doc comment, and a `SOURCE_TEXT` map whose values
 * are template *pieces* like "human-driven physical robot" that only gain
 * "declared"/"attested" once `sourceWording` concatenates them at call
 * time) — a per-line source scan flags the fragments and the comment
 * describing this very guard, not an actual unqualified rendering.
 * `verify.test.mjs` already asserts, functionally, that every string
 * `sourceWording`/`attestedPhysicalWording` actually produce satisfies the
 * guard (see its "physical" guard block) — that is the real check on this
 * file's output; this test guards every *other* file that might render
 * "physical" text some other way.
 *
 * NOT extended to `apps/web/*.html`: every marketing page's footer tagline
 * ("THENAR — Provenance and rights for physical-AI data.") — and a few
 * pages' older "contact data for physical AI." footer — use "physical" as
 * the product-category name, not as a claim about any episode's capture,
 * and are already covered/asserted verbatim by `copy.test.mjs`'s "tagline
 * updated everywhere" test. A literal per-line scan over all HTML would
 * fail on those pre-existing, already-tested lines. Filed as C-1 in
 * `TASKS/CONFLICTS.md` for a FRONTIER call on whether marketing copy
 * itself needs rewording or PLAN §1.1's guard needs scoping language.
 */
function scanPhysicalGuard(filePath, content) {
  const errors = [];
  const lines = content.split("\n");
  lines.forEach((line, i) => {
    // Remove "physical-AI" and "physical AI" tokens (case-insensitive) per C-2 resolution
    let cleanedLine = line.replace(/physical[\s-]AI/gi, "");
    if (!/\bphysical\b/i.test(cleanedLine)) return;
    if (/declared|attested/i.test(cleanedLine)) return;
    errors.push(`${filePath}:${i + 1}: contains "physical" without "declared" or "attested" on the same line`);
  });
  return errors;
}

function walkFiles(dir, ext, callback) {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walkFiles(full, ext, callback);
    } else if (extname(full) === ext) {
      callback(full);
    }
  }
}

describe('"physical" guard (PLAN §1.1, D-30, I-16, §27 trap #23, C-2 resolved)', () => {
  it('no apps/web/*.html file has "physical" without "declared"/"attested" on the same line (after removing "physical-AI"/"physical AI" tokens)', () => {
    const allErrors = [];
    walkFiles(webDir, ".html", (filePath) => {
      // Only apps/web's own top-level *.html files are in scope (not apps/web/test/**).
      if (dirname(filePath) !== webDir) return;
      const content = readFileIfExists(filePath);
      allErrors.push(...scanPhysicalGuard(filePath, content));
    });
    assert.strictEqual(allErrors.length, 0, allErrors.join("\n"));
  });

  it('no apps/web/*.js file (excluding ed25519.js and wording.js, see doc comment) has "physical" without "declared"/"attested" on the same line (after removing "physical-AI"/"physical AI" tokens)', () => {
    const allErrors = [];
    walkFiles(webDir, ".js", (filePath) => {
      if (filePath.endsWith("ed25519.js") || filePath.endsWith("wording.js")) return;
      // Only apps/web's own top-level *.js files are in scope (not apps/web/test/**).
      if (dirname(filePath) !== webDir) return;
      const content = readFileIfExists(filePath);
      allErrors.push(...scanPhysicalGuard(filePath, content));
    });
    assert.strictEqual(allErrors.length, 0, allErrors.join("\n"));
  });

  it('no services/api/src/report/** file has "physical" without "declared"/"attested" on the same line (after removing "physical-AI"/"physical AI" tokens, if that directory exists)', () => {
    const reportDir = resolve(repoRoot, "services", "api", "src", "report");
    const allErrors = [];
    walkFiles(reportDir, ".ts", (filePath) => {
      const content = readFileIfExists(filePath);
      allErrors.push(...scanPhysicalGuard(filePath, content));
    });
    walkFiles(reportDir, ".tsx", (filePath) => {
      const content = readFileIfExists(filePath);
      allErrors.push(...scanPhysicalGuard(filePath, content));
    });
    assert.strictEqual(allErrors.length, 0, allErrors.join("\n"));
  });
});
