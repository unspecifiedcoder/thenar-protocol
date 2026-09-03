/**
 * Every hand-encoded selector literal in the web pages must be real.
 *
 * `apps/web/*.js` and `apps/web/*.html` call the deployed contracts without a
 * web3 bundle — selectors are written by hand as `0x` + 8 hex digits, taken
 * from `cast sig` at the time and never checked again. A function that gets
 * renamed or removed leaves a page silently calling nothing (an `eth_call`
 * against an unknown selector returns empty data, which decodes to zero and
 * looks like "the log is empty" rather than "the page is broken").
 *
 * This derives the true selector set from the built ABIs (`forge build` must
 * have run — CI's "Contracts" step already does, before this suite runs) and
 * fails on any `0x[0-9a-f]{8}` literal in the shipped JS/HTML that is not in
 * that set. The regex is deliberately lower-case-only: `cast sig` and viem
 * both emit lower-case selectors, so an upper-case `0x…` match (GLB magic
 * numbers in `gl.js`, for instance) is data, not a selector, and is not
 * flagged.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { toFunctionSelector, type AbiFunction } from "viem";

let fails = 0;
const ok = (c: boolean, m: string, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };

const CONTRACTS_DIR = "packages/contracts";
const OUT_DIR = join(CONTRACTS_DIR, "out");
const WEB_DIR = "apps/web";

// The contracts the browser actually calls (D-14/D-15: one log, one
// stateless verifier; D-9: one registry, primary-chain only).
const DEPLOYED = ["GraspLog", "LeafVerifier", "LicenceRegistry"];

if (!existsSync(OUT_DIR)) {
  console.log(` FAIL  ${OUT_DIR} is missing — run \`forge build\` in ${CONTRACTS_DIR} first`);
  process.exit(1);
}

// selector -> "Name.function(sig)", so a mismatch names both what was called
// and what actually exists.
const known = new Map<string, string>();

for (const name of DEPLOYED) {
  const artifactPath = join(OUT_DIR, `${name}.sol`, `${name}.json`);
  ok(existsSync(artifactPath), `${artifactPath} exists (run \`forge build\`)`);
  if (!existsSync(artifactPath)) continue;
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  const fns = (artifact.abi as AbiFunction[]).filter((i) => i.type === "function");
  for (const fn of fns) {
    const selector = toFunctionSelector(fn);
    const sig = `${fn.name}(${fn.inputs.map((i) => i.type).join(",")})`;
    known.set(selector, `${name}.${sig}`);
  }
}
ok(known.size > 0, "derived at least one selector from the built ABIs", `${known.size}`);

// Every `0x…` selector-shaped literal actually used in the shipped web code.
const SELECTOR_RE = /0x[0-9a-f]{8}\b/g;
const files = readdirSync(WEB_DIR)
  .filter((f) => f.endsWith(".js") || f.endsWith(".html"))
  .map((f) => join(WEB_DIR, f));

let checked = 0;
for (const file of files) {
  const src = readFileSync(file, "utf8");
  const lines = src.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const matches = lines[i].match(SELECTOR_RE);
    if (!matches) continue;
    for (const sel of matches) {
      checked++;
      const hit = known.get(sel);
      ok(!!hit, `${file}:${i + 1} selector ${sel} is a real function`, hit ?? "no matching function in GraspLog/LeafVerifier/LicenceRegistry");
    }
  }
}
ok(checked > 0, "found selector literals to check in apps/web", `${checked}`);

console.log(fails === 0 ? "\nevery web selector is real\n" : `\n${fails} selector mismatch(es)\n`);
process.exit(fails ? 1 : 0);
