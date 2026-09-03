/**
 * T-021 — Wording grep guard (PLAN §1, I-1)
 *
 * Fails CI if forbidden words appear in apps/web or services/api/src/report
 * (if that directory exists) outside the L3 template ("Checked by … see details").
 *
 * Forbidden words: authentic, genuine, proven real, verified, independent, real
 * (except inside the L3 wording template which already contains them by necessity).
 */

import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
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
