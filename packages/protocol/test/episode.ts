/**
 * The episode leaf must be byte-identical in TypeScript and Solidity. If these
 * two ever drift, every proof breaks silently — the leaf still hashes, just to
 * something the chain will not recognise.
 */
import { keccak256, toHex, type Hex } from "viem";
import { encodeEpisode, hashEpisodeLeaf, episodeFacts, EPISODE_PREIMAGE_BYTES } from "../src/episode";

let fails = 0;
const ok = (c: boolean, m: string, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };
const h = (s: string): Hex => keccak256(toHex(s));

const ep = {
  payloadHash: h("payload"), manifestHash: h("manifest"),
  consentCommitment: h("consent"), termsId: h("terms-v1"), taskId: h("task-mug-shelf"),
  capturedAt: 1787000000n, submittedAt: 1787000060n,
  durationMs: 4200, scopeBits: 0b1011, channels: 6,
  worldSeed: 4242n, successFlag: 1, qualityScore: 7350,
};

const pre = encodeEpisode(ep);
ok((pre.length - 2) / 2 === EPISODE_PREIMAGE_BYTES, "an episode preimage is exactly 197 bytes", `${(pre.length - 2) / 2}`);
ok(pre.slice(0, 4) === "0x02", "the version byte is 0x02, so a capture can never be mistaken for one");
ok(hashEpisodeLeaf(pre).length === 66, "the leaf hash is 32 bytes");

// Field offsets are the contract's, so they are asserted here rather than trusted.
const raw = pre.slice(2);
const at = (off: number, len: number) => `0x${raw.slice(off * 2, (off + len) * 2)}`;
ok(at(1, 32) === ep.payloadHash, "payloadHash sits at offset 1");
ok(at(129, 32) === ep.taskId, "taskId sits at offset 129");
ok(BigInt(at(186, 8)) === ep.worldSeed, "worldSeed sits at offset 186");
ok(Number(BigInt(at(194, 1))) === 1, "successFlag sits at offset 194");
ok(Number(BigInt(at(195, 2))) === 7350, "qualityScore sits at offset 195");

const facts = episodeFacts(pre);
ok(facts.taskId === ep.taskId && facts.worldSeed === ep.worldSeed
   && facts.success === true && facts.qualityScore === 7350,
   "the decoder round-trips every field it advertises");

const failed = encodeEpisode({ ...ep, successFlag: 0, qualityScore: 1800 });
ok(episodeFacts(failed).success === false, "a failed attempt decodes as failed");
ok(episodeFacts(failed).qualityScore === 1800, "a failed attempt keeps its score");

let refused = false;
try { encodeEpisode({ ...ep, qualityScore: 10001 }); } catch { refused = true; }
ok(refused, "a score above 100% is refused rather than truncated");

// Any field change must change the leaf, or the commitment is meaningless.
const variants: [string, typeof ep][] = [
  ["taskId", { ...ep, taskId: h("another-task") }],
  ["worldSeed", { ...ep, worldSeed: 4243n }],
  ["successFlag", { ...ep, successFlag: 0 }],
  ["qualityScore", { ...ep, qualityScore: 7351 }],
];
let allDiffer = true;
for (const [, v] of variants) if (hashEpisodeLeaf(encodeEpisode(v)) === hashEpisodeLeaf(pre)) allDiffer = false;
ok(allDiffer, "changing any committed field changes the leaf", variants.map(([n]) => n).join(", "));

console.log(fails === 0 ? "\nepisode leaf: all checks passed\n" : `\n${fails} check(s) failed\n`);
process.exit(fails ? 1 : 0);
