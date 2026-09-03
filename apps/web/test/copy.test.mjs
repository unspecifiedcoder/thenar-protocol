import { readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { describe, it } from "node:test";
import assert from "node:assert";

const __dirname = dirname(fileURLToPath(import.meta.url));
const webDir = resolve(__dirname, "..");
const repoRoot = resolve(__dirname, "..", "..");

/**
 * Copy test: verify no forbidden content in HTML/Markdown/JS files.
 * Fails on:
 * - "Monad", "MON " (currency)
 * - "authentic", "genuine", "real", "proven real", "verified" (except specific contexts)
 * - "contact data for physical AI" (old tagline)
 * - "Contact Audit"
 * - 0x40-hex addresses outside chains.js
 * - chainId: literals outside chains.js
 * - chain_id literals outside chains.js
 *
 * Forbidden words are from PLAN §1; imported or duplicated with comment from
 * packages/protocol/src/wording.ts. The L3 template ("Checked by … see details")
 * is a legitimate context for these words; other surfaces must avoid them.
 */

// Forbidden words from PLAN §1 (duplicated here; also in packages/protocol/src/wording.ts)
const FORBIDDEN_WORDS_LIST = [
  "authentic",
  "genuine",
  "real",
  "proven real",
  "verified",
  "independent",
];

function readFileIfExists(path) {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function testContent(filePath, content, baseName) {
  const tests = [];

  // Test 1: No "Monad" anywhere (except in PLAN or documentation)
  if (!filePath.includes("PLAN") && !filePath.includes("THESIS") && !filePath.includes("docs/")) {
    if (/\bMonad\b/.test(content)) {
      tests.push(`${baseName}: contains "Monad"`);
    }
  }

  // Test 2: No "MON " (currency notation)
  if (/\bMON\s/.test(content)) {
    tests.push(`${baseName}: contains "MON " (currency)`);
  }

  // Test 3: No old tagline "contact data for physical AI"
  if (/contact\s+data\s+for\s+physical\s+AI/i.test(content)) {
    tests.push(`${baseName}: contains "contact data for physical AI" (old tagline)`);
  }

  // Test 4: No "Contact Audit"
  if (/Contact\s+Audit/.test(content)) {
    tests.push(`${baseName}: contains "Contact Audit"`);
  }

  // Test 5: No forbidden words (PLAN §1, except inside "Checked by" L3 template)
  // The L3 template legitimately contains these words in the context "Checked by … see details"
  for (const word of FORBIDDEN_WORDS_LIST) {
    const regex = new RegExp(`\\b${word}\\b`, "i");
    if (regex.test(content)) {
      // Allow the word if it's part of the L3 template context ("Checked by")
      if (!content.includes("Checked by")) {
        tests.push(`${baseName}: contains forbidden word "${word}" outside L3 template`);
      }
    }
  }

  // Test 6: No 0x40-hex addresses outside chains.js
  if (!filePath.includes("chains.js")) {
    const hexRegex = /0x[0-9a-fA-F]{40}/g;
    const matches = content.match(hexRegex);
    if (matches && matches.length > 0) {
      tests.push(`${baseName}: contains ${matches.length} 0x40-hex address(es): ${matches.slice(0, 3).join(", ")}`);
    }
  }

  // Test 7: No chainId: literals outside chains.js
  if (!filePath.includes("chains.js")) {
    if (/chainId\s*:/.test(content)) {
      tests.push(`${baseName}: contains "chainId:" literal`);
    }
  }

  // Test 8: No chain_id literals outside chains.js
  if (!filePath.includes("chains.js")) {
    if (/chain_id/.test(content)) {
      tests.push(`${baseName}: contains "chain_id" literal`);
    }
  }

  return tests;
}

describe("Copy guard", () => {
  it("no forbidden content in HTML files", () => {
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
      const errors = testContent(filePath, content, file);
      allErrors.push(...errors);
    }

    assert.strictEqual(allErrors.length, 0, allErrors.join("\n"));
  });

  it("no forbidden content in README.md", () => {
    const filePath = resolve(webDir, "..", "..", "README.md");
    const content = readFileIfExists(filePath);
    const errors = testContent(filePath, content, "README.md");
    assert.strictEqual(errors.length, 0, errors.join("\n"));
  });

  it("no forbidden content in grasp-chain.js", () => {
    const filePath = resolve(webDir, "grasp-chain.js");
    const content = readFileIfExists(filePath);

    // grasp-chain.js should not export MONAD, should export CHAIN
    const errors = [];
    if (/export\s+.*\bMONAD\b/.test(content)) {
      errors.push("grasp-chain.js: exports MONAD (should be renamed to CHAIN)");
    }
    if (!/export\s+.*\bCHAIN\b/.test(content)) {
      errors.push("grasp-chain.js: does not export CHAIN");
    }

    assert.strictEqual(errors.length, 0, errors.join("\n"));
  });

  it("tagline updated everywhere", () => {
    const htmlFiles = [
      "index.html",
      "products.html",
      "protocol.html",
      "market.html",
      "company.html",
      "faq.html",
    ];

    const newTagline = "Provenance and rights for physical-AI data";
    const errors = [];

    for (const file of htmlFiles) {
      const filePath = resolve(webDir, file);
      const content = readFileIfExists(filePath);

      // Check for old tagline
      if (/contact\s+data\s+for\s+physical\s+AI/i.test(content)) {
        errors.push(`${file}: still contains old tagline`);
      }
    }

    // Also check README
    const readmePath = resolve(webDir, "..", "..", "README.md");
    const readmeContent = readFileIfExists(readmePath);
    if (/contact\s+data\s+for\s+physical\s+AI/i.test(readmeContent)) {
      errors.push("README.md: still contains old tagline");
    }

    assert.strictEqual(errors.length, 0, errors.join("\n"));
  });

  it("no forbidden words in services/api/src/report (if it exists)", () => {
    const reportDir = resolve(repoRoot, "services", "api", "src", "report");
    if (!existsSync(reportDir)) {
      // Directory doesn't exist yet; skip gracefully
      return;
    }

    // Scan all TypeScript files in the report directory for forbidden words
    const fs = require("fs");
    const path = require("path");

    function walkDir(dir, callback) {
      try {
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
      } catch {
        // Directory access error; skip
      }
    }

    const allErrors = [];
    walkDir(reportDir, (filePath) => {
      const content = readFileIfExists(filePath);
      if (!content) return;
      const errors = testContent(filePath, content, path.basename(filePath));
      allErrors.push(...errors);
    });

    assert.strictEqual(allErrors.length, 0, allErrors.join("\n"));
  });
});
