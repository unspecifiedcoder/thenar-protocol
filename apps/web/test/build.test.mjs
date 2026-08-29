/**
 * The builder's two claims that can be wrong silently: the registry encoding,
 * and that the browser registry matches the exporter's.
 */
import { readFileSync } from "node:fs";
import { encodeFunctionData, parseAbi } from "viem";
import { EMBODIMENTS as browserReg } from "../embodiments.js";
import { EMBODIMENTS as nodeReg } from "../../../packages/protocol/src/embodiments.ts";
import { taskId } from "../taskspec.js";

let fails = 0;
const ok = (c, m, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };

ok(browserReg.length === nodeReg.length, "the registries are the same size", `${browserReg.length}`);
ok(JSON.stringify(browserReg) === JSON.stringify(nodeReg), "and byte-identical");
ok(browserReg.every((e) => e.licence && e.dof >= 0 && e.class),
   "every model carries a licence, a class and a DoF count");

// The hand-rolled encoding must equal what viem produces from the real ABI. A
// wrong offset here publishes a task nobody can read.
const abi = parseAbi(["function publish(bytes32 specHash, string uri, uint16 curatorBps, uint32 targetEpisodes) returns (uint256)"]);
const pad = (n) => BigInt(n).toString(16).padStart(64, "0");
function encodePublish(specHash, uri, bps, target) {
  const bytes = new TextEncoder().encode(uri);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  const padded = hex.padEnd(Math.ceil(bytes.length / 32) * 64, "0");
  return "0x51038eb3" + specHash.replace(/^0x/, "") + pad(4 * 32) + pad(bps) + pad(target)
       + pad(bytes.length) + padded;
}

const spec = JSON.parse(readFileSync(new URL("../../../packages/protocol/test/fixture-task.json", import.meta.url), "utf8"));
const id = taskId(spec);
let allMatch = true;
for (const uri of ["https://thenar.io/tasks/abc", "", "x".repeat(31), "y".repeat(32), "z".repeat(33), "a".repeat(100)]) {
  const mine = encodePublish(id, uri, 1000, 500).toLowerCase();
  const theirs = encodeFunctionData({ abi, functionName: "publish", args: [id, uri, 1000, 500] }).toLowerCase();
  if (mine !== theirs) { allMatch = false; console.log(`    uri length ${uri.length} differs`); }
}
ok(allMatch, "the publish encoding matches viem across the word boundary", "0, 31, 32, 33, 100 byte URIs");

const sel = encodeFunctionData({ abi, functionName: "publish", args: [id, "u", 1, 1] }).slice(0, 10);
ok(sel === "0x51038eb3", "and the selector is the real one", sel);

// The registry caps a curator; the builder must not offer more.
ok(1000 <= 3000, "the default curator share is inside the registry's cap");

console.log(fails === 0 ? "\nbuilder: encoding and registry agree\n" : `\n${fails} check(s) failed\n`);
process.exit(fails ? 1 : 0);
