/**
 * Leaves 0x03 (CorpusManifest) and 0x04 (VerificationClaim) must be
 * byte-identical in TypeScript and Solidity. If these two ever drift, every
 * proof breaks silently — the leaf still hashes, just to something the chain
 * will not recognise.
 */
import { keccak256, toHex, type Hex } from "viem";
import {
  encodeCorpus, decodeCorpus, corpusLeafHash, CORPUS_PREIMAGE_BYTES, CORPUS_VERSION,
  type CorpusLeaf,
} from "../src/corpus";
import {
  encodeClaim, decodeClaim, claimLeafHash, CLAIM_PREIMAGE_BYTES, CLAIM_VERSION,
  type ClaimLeaf,
} from "../src/claim";

let fails = 0;
const ok = (c: boolean, m: string, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };
const h = (s: string): Hex => keccak256(toHex(s));

// ------------------------------------------------------------- 0x03 corpus

const corpus: CorpusLeaf = {
  corpusManifestHash: h("corpus-manifest"),
  corpusRoot: h("corpus-root"),
  termsHash: h("terms-v1"),
  taskId: h("task-mug-shelf"),
  episodeCount: 42n,
  sealedAt: 1787000000n,
};

const cpre = encodeCorpus(corpus);
ok((cpre.length - 2) / 2 === CORPUS_PREIMAGE_BYTES, "a corpus preimage is exactly 145 bytes", `${(cpre.length - 2) / 2}`);
ok(cpre.slice(0, 4) === "0x03", "the version byte is 0x03");
ok(corpusLeafHash(cpre).length === 66, "the leaf hash is 32 bytes");

{
  const raw = cpre.slice(2);
  const at = (off: number, len: number) => `0x${raw.slice(off * 2, (off + len) * 2)}`;
  ok(at(1, 32) === corpus.corpusManifestHash, "corpusManifestHash sits at offset 1");
  ok(at(33, 32) === corpus.corpusRoot, "corpusRoot sits at offset 33");
  ok(at(65, 32) === corpus.termsHash, "termsHash sits at offset 65");
  ok(at(97, 32) === corpus.taskId, "taskId sits at offset 97");
  ok(BigInt(at(129, 8)) === corpus.episodeCount, "episodeCount sits at offset 129");
  ok(BigInt(at(137, 8)) === corpus.sealedAt, "sealedAt sits at offset 137");
}

ok(CORPUS_VERSION === 3, "CORPUS_VERSION is 3");

const cdecoded = decodeCorpus(cpre);
ok(JSON.stringify(cdecoded, (_, v) => typeof v === "bigint" ? v.toString() : v)
   === JSON.stringify(corpus, (_, v) => typeof v === "bigint" ? v.toString() : v),
   "decodeCorpus(encodeCorpus(x)) round-trips");

{
  let refused = false;
  try { encodeCorpus({ ...corpus, episodeCount: 0n }); } catch { refused = true; }
  ok(refused, "episodeCount == 0 is refused on encode");
}
{
  let refused = false;
  try { decodeCorpus(("0x00" + cpre.slice(4)) as Hex); } catch { refused = true; }
  ok(refused, "an unsupported version is refused on decode");
}
{
  let refused = false;
  try { decodeCorpus((cpre + "00") as Hex); } catch { refused = true; }
  ok(refused, "a wrong-length preimage is refused on decode");
}

// ------------------------------------------------------------- 0x04 claim

const claim: ClaimLeaf = {
  subjectLeaf: h("subject-leaf"),
  verifierKeyId: h("verifier-key"),
  detailHash: h("detail"),
  signatureHash: h("signature"),
  checkId: 3,
  result: 1,
  levelAsserted: 2,
  issuedAt: 1787000100n,
};

const kpre = encodeClaim(claim);
ok((kpre.length - 2) / 2 === CLAIM_PREIMAGE_BYTES, "a claim preimage is exactly 141 bytes", `${(kpre.length - 2) / 2}`);
ok(kpre.slice(0, 4) === "0x04", "the version byte is 0x04");
ok(claimLeafHash(kpre).length === 66, "the leaf hash is 32 bytes");

{
  const raw = kpre.slice(2);
  const at = (off: number, len: number) => `0x${raw.slice(off * 2, (off + len) * 2)}`;
  ok(at(1, 32) === claim.subjectLeaf, "subjectLeaf sits at offset 1");
  ok(at(33, 32) === claim.verifierKeyId, "verifierKeyId sits at offset 33");
  ok(at(65, 32) === claim.detailHash, "detailHash sits at offset 65");
  ok(at(97, 32) === claim.signatureHash, "signatureHash sits at offset 97");
  ok(Number(BigInt(at(129, 2))) === claim.checkId, "checkId sits at offset 129");
  ok(Number(BigInt(at(131, 1))) === claim.result, "result sits at offset 131");
  ok(Number(BigInt(at(132, 1))) === claim.levelAsserted, "levelAsserted sits at offset 132");
  ok(BigInt(at(133, 8)) === claim.issuedAt, "issuedAt sits at offset 133");
}

ok(CLAIM_VERSION === 4, "CLAIM_VERSION is 4");

const kdecoded = decodeClaim(kpre);
ok(JSON.stringify(kdecoded, (_, v) => typeof v === "bigint" ? v.toString() : v)
   === JSON.stringify(claim, (_, v) => typeof v === "bigint" ? v.toString() : v),
   "decodeClaim(encodeClaim(x)) round-trips");

const rejections: [string, Partial<ClaimLeaf>][] = [
  ["result > 2", { result: 3 as 0 | 1 | 2 }],
  ["levelAsserted > 4", { levelAsserted: 5 }],
  ["checkId == 0", { checkId: 0 }],
  ["issuedAt == 0", { issuedAt: 0n }],
];
for (const [name, patch] of rejections) {
  let refused = false;
  try { encodeClaim({ ...claim, ...patch }); } catch { refused = true; }
  ok(refused, `${name} is refused on encode`);
}
{
  let refused = false;
  try { decodeClaim(("0x00" + kpre.slice(4)) as Hex); } catch { refused = true; }
  ok(refused, "an unsupported version is refused on decode");
}
{
  let refused = false;
  try { decodeClaim((kpre + "00") as Hex); } catch { refused = true; }
  ok(refused, "a wrong-length preimage is refused on decode");
}

// Any field change must change the leaf, or the commitment is meaningless.
{
  const variants: [string, ClaimLeaf][] = [
    ["checkId", { ...claim, checkId: 4 }],
    ["result", { ...claim, result: 0 }],
    ["levelAsserted", { ...claim, levelAsserted: 3 }],
    ["issuedAt", { ...claim, issuedAt: 1787000101n }],
  ];
  let allDiffer = true;
  for (const [, v] of variants) if (claimLeafHash(encodeClaim(v)) === claimLeafHash(kpre)) allDiffer = false;
  ok(allDiffer, "changing any committed claim field changes the leaf", variants.map(([n]) => n).join(", "));
}

console.log(fails === 0 ? "\ncorpus/claim leaves: all checks passed\n" : `\n${fails} check(s) failed\n`);
process.exit(fails ? 1 : 0);
