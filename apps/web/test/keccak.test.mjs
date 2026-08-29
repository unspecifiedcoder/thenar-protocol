/** The browser keccak must equal the one the chain and the sampler use. */
import { keccak256 as ours } from "../keccak.js";
import { keccak256 as theirs, toHex } from "viem";

let fails = 0;
const ok = (c, m, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };

// The canonical empty-input digest. If padding is wrong this is the first thing
// that breaks, and it is the difference between Keccak and SHA3.
ok(ours("0x") === "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
   "empty input matches the known Keccak-256 digest");

const vectors = ["0x00", "0xff", "0xdeadbeef", "0x" + "61".repeat(135),
                 "0x" + "62".repeat(136), "0x" + "63".repeat(137), "0x" + "00".repeat(200)];
let all = true;
for (const v of vectors) if (ours(v) !== theirs(v)) { all = false; console.log(`    differs at ${v.slice(0, 20)}…`); }
ok(all, "matches viem across the rate boundary", `${vectors.length} vectors incl. 135/136/137 bytes`);

// Random input, because a hash that only matches the cases you thought of is
// a hash you have not tested.
let rnd = true;
for (let i = 0; i < 250; i++) {
  const n = 1 + Math.floor(Math.random() * 300);
  const b = new Uint8Array(n);
  for (let k = 0; k < n; k++) b[k] = Math.floor(Math.random() * 256);
  const hex = "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  if (ours(hex) !== theirs(hex)) { rnd = false; break; }
}
ok(rnd, "matches viem on 250 random inputs up to 300 bytes");
ok(ours("0x").length === 66, "output is 32 bytes");

console.log(fails === 0 ? "\nkeccak: all checks passed\n" : `\n${fails} check(s) failed\n`);
process.exit(fails ? 1 : 0);
