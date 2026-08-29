/**
 * Every declared suite must actually run in CI.
 *
 * `test:export` and `test:web` were declared and wired into `pnpm test`, but
 * the workflow never ran them — 72 checks sat unguarded, including the two
 * cross-implementation ones that stop the site rebuilding the wrong world.
 */
import { readFileSync } from "node:fs";

let fails = 0;
const ok = (c: boolean, m: string, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const ci = readFileSync(".github/workflows/ci.yml", "utf8");
/* A suite may be left out of CI only for a reason written down here. Silence
   is how test:export and test:web went unrun; an exemption has to be a
   decision, not an omission. */
const EXEMPT: Record<string, string> = {
  "test:parity": "compares against a sibling checkout that CI does not have",
};

const suites = Object.keys(pkg.scripts).filter((k) => k.startsWith("test:"));
ok(suites.length > 0, "the package declares test suites", suites.join(", "));

for (const s of suites) {
  // `test:contracts` is `forge test`, which CI runs directly in the contracts
  // package so it fails before Node is installed.
  if (EXEMPT[s]) { console.log(`  --   ${s} is deliberately out of CI — ${EXEMPT[s]}`); continue; }
  const covered = ci.includes(`pnpm ${s}`) ||
    (s === "test:contracts" && /forge test/.test(ci));
  ok(covered, `CI runs ${s}`);
}

// `pnpm test` must itself chain every suite, or running it locally proves less
// than it appears to.
const agg = pkg.scripts.test ?? "";
for (const s of suites) {
  if (s === "test" || EXEMPT[s]) continue;
  ok(agg.includes(s), `pnpm test chains ${s}`);
}

console.log(fails === 0 ? "\nCI covers every suite\n" : `\n${fails} suite(s) unguarded\n`);
process.exit(fails ? 1 : 0);
