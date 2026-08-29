/* Exercise the /verify page's own encoder against the real anchored capture. */
import { readFileSync } from "node:fs";
const s = JSON.parse(readFileSync("apps/web/sample-proof.json", "utf8"));
const RPC = "https://testnet-rpc.monad.xyz";
const SELECTOR = "0xe51f9888";
const pad = (n) => BigInt(n).toString(16).padStart(64, "0");
function encodeVerify(index, preimage, proof, leafIndex) {
  const raw = preimage.replace(/^0x/, "");
  const bytesLen = raw.length / 2;
  const padded = raw.padEnd(Math.ceil(bytesLen / 32) * 64, "0");
  const bytesOffset = 4 * 32;
  const proofOffset = bytesOffset + (1 + Math.ceil(bytesLen / 32)) * 32;
  return SELECTOR + pad(index) + pad(bytesOffset) + pad(proofOffset) + pad(leafIndex)
    + pad(bytesLen) + padded
    + pad(proof.length) + proof.map((h) => h.replace(/^0x/, "").padStart(64, "0")).join("");
}
const call = async (data) => {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: s.log, data }, "latest"] }) });
  const j = await r.json(); if (j.error) throw new Error(j.error.message); return j.result;
};
const yes = BigInt(await call(encodeVerify(s.anchorIndex, s.preimage, s.proof, s.leafIndex))) === 1n;
console.log(`the page's encoder against the real capture -> ${yes ? "IN THE LOG" : "not in the log"}`);

// One byte changed must flip it, or the commitment means nothing.
const flipped = "0x" + s.preimage.slice(2, -2) + (s.preimage.slice(-2) === "06" ? "07" : "06");
const no = BigInt(await call(encodeVerify(s.anchorIndex, flipped, s.proof, s.leafIndex))) === 1n;
console.log(`same proof with one byte altered      -> ${no ? "STILL ACCEPTED (bad)" : "refused"}`);
process.exit(yes && !no ? 0 : 1);
