/**
 * Every module a page imports must exist.
 *
 * gl.js was deleted once as an "orphan" because no HTML referenced it, while
 * two modules imported it. A failed import kills the whole page module, so the
 * reveal animations, the grasp trace, the chain reader and the contact form all
 * stopped attaching at once, and the site shipped that way. This is the guard.
 */
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, bytesToHex } from "../keccak.js";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
let fails = 0;
const ok = (c, m, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };

function collectFiles(dir) {
  const files = [];
  for (const f of readdirSync(dir)) {
    if (f.endsWith(".js") || f.endsWith(".html")) {
      files.push(join(dir, f));
    }
  }
  // Also check subdirectories like lab/
  for (const d of readdirSync(dir)) {
    const p = join(dir, d);
    const s = statSync(p);
    if (s.isDirectory() && !d.startsWith(".") && d !== "node_modules" && d !== "test") {
      for (const f of readdirSync(p)) {
        if (f.endsWith(".js") || f.endsWith(".html")) {
          files.push(join(p, f));
        }
      }
    }
  }
  return files;
}

const files = collectFiles(web);
const referenced = new Set();
let checked = 0;

for (const f of files) {
  const src = readFileSync(f, "utf8");
  const imports = [
    ...src.matchAll(/from\s+"(\.\.?\/[a-zA-Z0-9._\-/]+\.js)"/g),
    ...src.matchAll(/import\s*\(\s*"(\.\.?\/[a-zA-Z0-9._\-/]+\.js)"/g),
    ...src.matchAll(/src="(\.\.?\/[a-zA-Z0-9._\-/]+\.js)"/g),
  ].map((m) => m[1]);
  for (const spec of imports) {
    checked++;
    const moduleName = spec.split('/').pop();
    referenced.add(moduleName);
    const resolvedPath = resolve(dirname(f), spec);
    ok(existsSync(resolvedPath), `${f} imports ${spec}`);
  }
}
ok(checked > 0, "found imports to check", `${checked}`);

// A module nothing reaches is dead weight — but only report it, because
// deleting on that signal alone is what caused the outage.
// Only check top-level modules; subdirectory modules (like lab/) can be intentionally unreferenced.
const shipped = readdirSync(web).filter((f) => f.endsWith(".js"));
const unreferenced = shipped.filter((f) => !referenced.has(f));
ok(unreferenced.length === 0, "no shipped module is unreachable",
   unreferenced.length ? unreferenced.join(", ") : "");

// Every stylesheet a page links must exist too.
for (const f of files.filter((x) => x.endsWith(".html"))) {
  const src = readFileSync(f, "utf8");
  for (const m of src.matchAll(/href="(\.\.?\/[a-zA-Z0-9._\-/]+\.css)"/g)) {
    const spec = m[1];
    const resolvedPath = resolve(dirname(f), spec);
    ok(existsSync(resolvedPath), `${f} links ${spec}`);
  }
}

// T-026: `ed25519.js` vendors `@noble/ed25519` (package version 3.2.0) plus
// an inlined standalone SHA-512, with no bundler to check it for us — so its
// content is pinned by a keccak of its bytes. Any edit (accidental or
// otherwise) to the vendored body, the sha512 addition, or the wiring
// between them changes this hash and fails the build; updating it is a
// deliberate act, not something a diff should do quietly.
const ED25519_KECCAK = "0x38411f561c404bb91a4af61d36432bbc57347bbbc634a3cae0cf4b03545679ad";
{
  const bytes = readFileSync(join(web, "ed25519.js"));
  const got = keccak256(bytesToHex(new Uint8Array(bytes)));
  ok(got === ED25519_KECCAK, "ed25519.js content is pinned by keccak", got === ED25519_KECCAK ? "" : `got ${got}`);
}

console.log(fails === 0 ? "\nweb imports: all resolve\n" : `\n${fails} broken reference(s)\n`);
process.exit(fails ? 1 : 0);
