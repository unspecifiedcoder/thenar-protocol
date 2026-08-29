/**
 * Prove GRASP on chain: build a real log, anchor it, prove a clip is in it,
 * prove the log was only appended to, prove consent was never withdrawn,
 * withdraw one and prove the block that became knowable at, then buy a licence
 * under published terms.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createPublicClient, createWalletClient, http, parseAbi, keccak256, toHex, parseEther, formatEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { encodeClip, hashLeaf, commitConsent } from "../packages/protocol/src/leaf.ts";
import * as mlog from "../packages/protocol/src/log.ts";
import { SparseTree } from "../packages/protocol/src/sparse.ts";

const env = Object.fromEntries(readFileSync(".env.deployer", "utf8").split("\n").filter(Boolean)
  .map((l) => { const i = l.indexOf("="); return [l.slice(0, i), l.slice(i + 1)]; }));
const LOG = process.env.GRASP_LOG ?? "";
const MARKET = process.env.GRASP_MARKET ?? "";

if (!LOG || !MARKET) {
  throw new Error("Set GRASP_LOG and GRASP_MARKET — nothing is deployed on Fuji yet.");
}
const chain = { id: 43113, name: "Avalanche Fuji", nativeCurrency: { name: "Avalanche", symbol: "AVAX", decimals: 18 },
  rpcUrls: { default: { http: ["https://api.avax-test.network/ext/bc/C/rpc"] } } };
const account = privateKeyToAccount(env.DEPLOYER_PRIVATE_KEY);
const pub = createPublicClient({ chain, transport: http() });
const wallet = createWalletClient({ account, chain, transport: http() });
// Monad reserves value + gas_limit x price, not value + gas_used, so an
// oversized limit locks up balance that the transaction never spends. These
// are sized to the actual cost of each call with headroom, not guessed high.
// Measured with eth_estimateGas, not guessed: purchase writes a nine-field
// receipt and makes an external call, and came in at 252,867.
const GAS_ANCHOR = 200000n;
const GAS_TERMS = 220000n;
const GAS_PURCHASE = 400000n;

const logAbi = parseAbi([
  "function anchor(bytes32 root, uint64 size, bytes32 revocationRoot) returns (uint256)",
  "function anchorCount() view returns (uint256)",
  "function anchorAt(uint256) view returns ((bytes32 root, bytes32 prevRoot, bytes32 revocationRoot, uint64 size, uint64 at, uint64 blockNumber))",
  "function verifyClip(uint256 index, bytes preimage, bytes32[] proof, uint64 leafIndex) view returns (bool)",
  "function verifyAppendOnly(uint256 earlier, uint256 later, bytes32[] proof) view returns (bool)",
  "function verifyConsentLive(uint256 index, bytes32 consentKey, uint256 bitmap, bytes32[] siblings) view returns (bool)",
  "function revocationOnset(uint256 index, (bytes32 consentKey, bytes32 value, uint256 bitmapAt, bytes32[] siblingsAt, uint256 bitmapBefore, bytes32[] siblingsBefore) p) view returns (uint64, uint64)",
]);
const marketAbi = parseAbi([
  "function publishTerms(bytes32 documentHash, string uri) returns (uint256)",
  "function termsCount() view returns (uint256)",
  "function purchase(uint256 termsId, uint256 anchorIndex, bytes32 corpusRoot, uint64 corpusSize, address token, uint256 amount) payable returns (uint256)",
  "function receiptCount() view returns (uint256)",
  "function receiptAt(uint256) view returns ((address buyer, uint256 termsId, bytes32 corpusRoot, uint64 corpusSize, uint256 anchorIndex, address token, uint256 amount, uint64 at, uint64 blockNumber))",
]);

let failed = 0;
const check = (ok, m, x = "") => { if (!ok) failed++; console.log(`${ok ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };
const send = async (address, abi, functionName, args, value, gas = GAS_ANCHOR) => {
  const hash = await wallet.writeContract({ address, abi, functionName, args, gas, ...(value !== undefined ? { value } : {}) });
  const r = await pub.waitForTransactionReceipt({ hash });
  if (r.status !== "success") throw new Error(`${functionName} reverted — ${hash}`);
  return { hash, receipt: r };
};
const h = (s) => keccak256(toHex(s));

console.log(`\nGRASP end-to-end · Avalanche Fuji\nlog    ${LOG}\nmarket ${MARKET}`);
console.log(`balance ${formatEther(await pub.getBalance({ address: account.address }))} MON\n`);

// ---- a real batch of captured clips ----------------------------------------
const now = BigInt(Math.floor(Date.now() / 1000));
const clips = Array.from({ length: 8 }, (_, i) => ({
  consentKey: h(`consent-key-${i}-${now}`),
  consentRecord: h(`consent-record-${i}-${now}`),
  clip: {
    payloadHash: h(`clip-payload-${i}-${now}`),
    manifestHash: h("band-manifest-v1"),
    consentCommitment: commitConsent(h(`consent-record-${i}-${now}`), h(`salt-${i}-${now}`)),
    termsId: h("thenar-licence-v1"),
    capturedAt: now - BigInt(600 - i * 60),
    submittedAt: now - BigInt(300 - i * 30),
    durationMs: 3200 + i * 140,
    scopeBits: 0b1011,
    channels: 6,
  },
}));
const preimages = clips.map((c) => encodeClip(c.clip));
const leaves = preimages.map(hashLeaf);
check(preimages.every((p) => (p.length - 2) / 2 === 154), "every clip preimage is 154 bytes");

// ---- anchor the first batch ------------------------------------------------
const FIRST = 5;
const rootFirst = mlog.root(leaves.slice(0, FIRST));
const revocations = new SparseTree();
const startIndex = Number(await pub.readContract({ address: LOG, abi: logAbi, functionName: "anchorCount" }));
let tx = await send(LOG, logAbi, "anchor", [rootFirst, BigInt(FIRST), revocations.root()]);
check(true, `anchored ${FIRST} clips`, tx.hash.slice(0, 18));
const iFirst = startIndex;

// ---- a clip proves it is in the log, on chain ------------------------------
const pick = 3;
const proof = mlog.inclusionProof(leaves.slice(0, FIRST), pick);
const inLog = await pub.readContract({
  address: LOG, abi: logAbi, functionName: "verifyClip",
  args: [BigInt(iFirst), preimages[pick], proof, BigInt(pick)],
});
check(inLog === true, "the chain confirms a clip is in the anchored log", `leaf ${pick}, ${proof.length}-word proof`);

const tampered = await pub.readContract({
  address: LOG, abi: logAbi, functionName: "verifyClip",
  args: [BigInt(iFirst), preimages[pick === 0 ? 1 : 0], proof, BigInt(pick)],
});
check(tampered === false, "a substituted clip is refused by the same proof");

// ---- consent is live -------------------------------------------------------
let pOut = revocations.proof(clips[pick].consentKey);
let live = await pub.readContract({
  address: LOG, abi: logAbi, functionName: "verifyConsentLive",
  args: [BigInt(iFirst), clips[pick].consentKey, pOut.bitmap, pOut.siblings],
});
check(live === true, "the chain confirms consent was never withdrawn");

// ---- extend the log, and prove nothing was rewritten -----------------------
const rootAll = mlog.root(leaves);
tx = await send(LOG, logAbi, "anchor", [rootAll, BigInt(leaves.length), revocations.root()]);
const iAll = iFirst + 1;
check(true, `extended the log to ${leaves.length} clips`, tx.hash.slice(0, 18));

const cproof = mlog.consistencyProof(leaves, FIRST, leaves.length);
const appendOnly = await pub.readContract({
  address: LOG, abi: logAbi, functionName: "verifyAppendOnly",
  args: [BigInt(iFirst), BigInt(iAll), cproof],
});
check(appendOnly === true, "the chain confirms the log was only appended to", `${cproof.length}-word proof`);

// ---- a contributor withdraws consent ---------------------------------------
const withdrawn = clips[6];
const before = revocations.proof(withdrawn.consentKey);
revocations.set(withdrawn.consentKey, withdrawn.consentRecord);
tx = await send(LOG, logAbi, "anchor", [mlog.root(leaves.slice(0, 7)), BigInt(leaves.length + 1), revocations.root()]);
const iRevoked = iAll + 1;
check(true, "anchored the withdrawal", tx.hash.slice(0, 18));

const after = revocations.proof(withdrawn.consentKey);
const [onsetBlock] = await pub.readContract({
  address: LOG, abi: logAbi, functionName: "revocationOnset",
  args: [BigInt(iRevoked), {
    consentKey: withdrawn.consentKey, value: withdrawn.consentRecord,
    bitmapAt: after.bitmap, siblingsAt: after.siblings,
    bitmapBefore: before.bitmap, siblingsBefore: before.siblings,
  }],
});
const anchorRow = await pub.readContract({ address: LOG, abi: logAbi, functionName: "anchorAt", args: [BigInt(iRevoked)] });
check(onsetBlock === anchorRow.blockNumber, "the chain reports the block the withdrawal became knowable", `block ${onsetBlock}`);

const stillLive = await pub.readContract({
  address: LOG, abi: logAbi, functionName: "verifyConsentLive",
  args: [BigInt(iRevoked), withdrawn.consentKey, after.bitmap, after.siblings],
});
check(stillLive === false, "a withdrawn clip can no longer prove consent is live");

// ---- terms and payment, in one transaction ---------------------------------
const termsHash = h("THENAR capture licence v1");
const termsBefore = Number(await pub.readContract({ address: MARKET, abi: marketAbi, functionName: "termsCount" }));
tx = await send(MARKET, marketAbi, "publishTerms", [termsHash, "https://thenar.io/terms/capture-v1"], undefined, GAS_TERMS);
const termsId = termsBefore;
check(true, `published licence terms #${termsId}`, tx.hash.slice(0, 18));

const PRICE = parseEther("0.002");
const corpus = await pub.readContract({ address: LOG, abi: logAbi, functionName: "anchorAt", args: [BigInt(iAll)] });
tx = await send(MARKET, marketAbi, "purchase",
  [BigInt(termsId), BigInt(iAll), corpus.root, corpus.size, "0x0000000000000000000000000000000000000000", PRICE], PRICE, GAS_PURCHASE);
check(true, "bought a licence — payment and terms in one transaction", tx.hash.slice(0, 18));

const rid = Number(await pub.readContract({ address: MARKET, abi: marketAbi, functionName: "receiptCount" })) - 1;
const receipt = await pub.readContract({ address: MARKET, abi: marketAbi, functionName: "receiptAt", args: [BigInt(rid)] });
check(receipt.corpusRoot === corpus.root, "the receipt names the corpus the log actually anchored");
check(receipt.amount === PRICE, "the receipt records what was paid", `${formatEther(receipt.amount)} MON`);
check(receipt.termsId === BigInt(termsId), "the receipt cites the licence version");

// a corpus that was never anchored cannot be sold
let refused = false;
try {
  await pub.simulateContract({ address: MARKET, abi: marketAbi, functionName: "purchase", account,
    args: [BigInt(termsId), BigInt(iAll), h("a-corpus-that-never-existed"), corpus.size, "0x0000000000000000000000000000000000000000", PRICE], value: PRICE });
} catch { refused = true; }
check(refused, "a corpus the log never anchored cannot be sold");

// Persist real verification material so /verify can be exercised with values
// that actually check out, rather than a worked example nobody can reproduce.
writeFileSync("apps/web/sample-proof.json", JSON.stringify({
  network: "Monad Testnet (10143)",
  log: LOG,
  market: MARKET,
  anchorIndex: iFirst,
  leafIndex: pick,
  preimage: preimages[pick],
  proof,
  expected: true,
  note: "Paste these into /verify. The contract should answer: in the log.",
}, null, 2));
console.log(`\nwrote apps/web/sample-proof.json — real values for /verify`);
console.log(`anchors now ${await pub.readContract({ address: LOG, abi: logAbi, functionName: "anchorCount" })}`);
console.log(`balance left ${formatEther(await pub.getBalance({ address: account.address }))} MON`);
console.log(failed === 0 ? "\nGRASP verified end to end on Avalanche Fuji\n" : `\n${failed} check(s) failed\n`);
process.exit(failed ? 1 : 0);
