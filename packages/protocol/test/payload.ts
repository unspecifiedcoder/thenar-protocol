/**
 * T-002 -- payloadHash over container files (PLAN §10.4, D-4, D-18).
 *
 * Fixed vectors are hard-coded (computed once with this implementation,
 * then pasted as hex) so this is a real regression check, not a tautology
 * that would pass even if `payloadHash`/`fileLeaf` silently changed shape.
 */
import { keccak256, type Hex } from "viem";
import {
  assertPath,
  fileLeaf,
  payloadHash,
  hashStream,
  buildFileEntries,
  type FileEntry,
} from "../src/payload";
import { root as ctRoot } from "../src/log";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let fails = 0;
const ok = (c: boolean, m: string, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` -- ${x}` : ""}`); };

const enc = new TextEncoder();

// -------------------------------------------------------------- fixed vectors
//
// Three small in-memory files. Bytes and their keccak256 (viem, over the raw
// bytes) fully determine the inputs; `fileLeaf`/`payloadHash` outputs below
// are pasted from a run of this exact implementation (see task notes) and
// are what makes this a regression test rather than a self-check.
const vectorFiles: { path: string; data: Uint8Array }[] = [
  { path: "data/chunk-000/file-000.parquet", data: enc.encode("alpha bytes") },
  { path: "videos/cam/chunk-000/file-000.mp4", data: enc.encode("beta video bytes") },
  { path: "meta/info.json", data: enc.encode('{"gamma":true}') },
];
const vectorEntries: FileEntry[] = vectorFiles.map((f) => ({
  path: f.path,
  bytes: f.data.length,
  hash: keccak256(f.data) as Hex,
}));

const expectedFileLeaves: Record<string, Hex> = {
  "data/chunk-000/file-000.parquet": "0x8f86db636d83d77bf6ab5999a5271672b3b23e0bed0ccddace5754c06bfa182d",
  "videos/cam/chunk-000/file-000.mp4": "0xdc1cd899f94380f442b1c717db1689a110deb23ef866f106b118a7d2c43c9b6f",
  "meta/info.json": "0xb5223592187e6909cc38cb5f91c6cc805199f31aa49b459e7326a12dbb74954e",
};
for (const e of vectorEntries) {
  ok(fileLeaf(e.path, e.hash) === expectedFileLeaves[e.path], `fileLeaf vector matches -- ${e.path}`);
}

const expectedPayloadHash: Hex = "0xc2c163431119feffc9fe104ed9c110397a4b397d3254ae324cf2c381bb667f53";
ok(payloadHash(vectorEntries) === expectedPayloadHash, "payloadHash vector (3 files) matches");

const expectedSingleFilePayloadHash: Hex = "0x8f86db636d83d77bf6ab5999a5271672b3b23e0bed0ccddace5754c06bfa182d";
ok(payloadHash([vectorEntries[0]]) === expectedSingleFilePayloadHash,
   "one file ⇒ payloadHash is exactly its fileLeaf");
ok(expectedSingleFilePayloadHash === expectedFileLeaves["data/chunk-000/file-000.parquet"],
   "sanity: single-file payloadHash literal equals that file's fileLeaf literal");

// --------------------------------------------------------- permutation property
{
  const base = payloadHash(vectorEntries);
  let allMatch = true;
  const arr = [...vectorEntries];
  for (let i = 0; i < 20; i++) {
    // Fisher-Yates shuffle.
    const shuffled = [...arr];
    for (let j = shuffled.length - 1; j > 0; j--) {
      const k = Math.floor(Math.random() * (j + 1));
      [shuffled[j], shuffled[k]] = [shuffled[k], shuffled[j]];
    }
    if (payloadHash(shuffled) !== base) allMatch = false;
  }
  ok(allMatch, "payloadHash is invariant under any permutation of files[] (20 shuffles)");
}

// ------------------------------------------------------ single-byte-change property
{
  function payloadHashOf(files: { path: string; data: Uint8Array }[]): Hex {
    return payloadHash(files.map((f) => ({ path: f.path, bytes: f.data.length, hash: keccak256(f.data) as Hex })));
  }
  const base = payloadHashOf(vectorFiles);
  let allChanged = true;
  for (let i = 0; i < vectorFiles.length; i++) {
    const mutated = vectorFiles.map((f, j) => {
      if (j !== i) return f;
      const data = new Uint8Array(f.data);
      data[0] = (data[0] + 1) % 256; // flip byte 0
      return { path: f.path, data };
    });
    if (payloadHashOf(mutated) === base) allChanged = false;
  }
  ok(allChanged, "flipping one byte in any file's content changes payloadHash");
}

// ------------------------------------------------------------------- duplicates / empty
{
  let threw = false;
  try { payloadHash([]); } catch { threw = true; }
  ok(threw, "payloadHash([]) throws (zero files invalid)");
}
{
  let threw = false;
  try {
    payloadHash([
      { path: "a", bytes: 1, hash: keccak256(enc.encode("x")) as Hex },
      { path: "a", bytes: 1, hash: keccak256(enc.encode("y")) as Hex },
    ]);
  } catch { threw = true; }
  ok(threw, "payloadHash rejects duplicate paths");
}

// ------------------------------------------------------- non-ASCII / byte sort
{
  // "B" (0x42) sorts before "a" (0x61) bytewise, but `"a".localeCompare("B")`
  // sorts the other way in the default locale -- a real divergence, not a
  // hypothetical one (verified: `"B".localeCompare("a") > 0` while
  // `Buffer.compare(Buffer.from("B"), Buffer.from("a")) < 0`). If `payloadHash`
  // ever switched to `localeCompare` (§27 trap #2), this would silently
  // reorder the leaves and change nothing about invariance under permutation
  // (that property test would still pass) -- only comparing against a
  // hand-built byte-order tree catches it.
  ok("B".localeCompare("a") > 0, "sanity: localeCompare would put \"a\" before \"B\"");
  ok(Buffer.compare(Buffer.from("B"), Buffer.from("a")) < 0, "sanity: byte order puts \"B\" before \"a\"");

  const bFile: FileEntry = { path: "B", bytes: 1, hash: keccak256(enc.encode("1")) as Hex };
  const aFile: FileEntry = { path: "a", bytes: 1, hash: keccak256(enc.encode("2")) as Hex };
  const byteOrderRoot = ctRoot([fileLeaf(bFile.path, bFile.hash), fileLeaf(aFile.path, aFile.hash)]);
  const localeOrderRoot = ctRoot([fileLeaf(aFile.path, aFile.hash), fileLeaf(bFile.path, bFile.hash)]);
  ok(byteOrderRoot !== localeOrderRoot, "sanity: the two orderings actually produce different roots");
  ok(payloadHash([aFile, bFile]) === byteOrderRoot, "payloadHash sorts by UTF-8 bytes, not localeCompare (input a,B)");
  ok(payloadHash([bFile, aFile]) === byteOrderRoot, "payloadHash sorts by UTF-8 bytes, not localeCompare (input B,a)");
}

// --------------------------------------------------------------------- hashStream
async function toChunks(data: Uint8Array, chunkSize: number): Promise<AsyncIterable<Uint8Array>> {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += chunkSize) chunks.push(data.subarray(i, i + chunkSize));
  if (chunks.length === 0) chunks.push(new Uint8Array(0));
  async function* gen() { for (const c of chunks) yield c; }
  return gen();
}

async function testHashStreamLengths() {
  const lengths = [0, 1, 135, 136, 137, 1024 * 1024];
  for (const len of lengths) {
    const data = new Uint8Array(len);
    for (let i = 0; i < len; i++) data[i] = i % 256;
    const expected = keccak256(data) as Hex;
    // Feed it back in irregular chunks to exercise the incremental path.
    const chunkSize = Math.max(1, Math.floor(len / 7) || 1);
    const got = await hashStream(await toChunks(data, chunkSize));
    ok(got === expected, `hashStream matches keccak256(buffer) for length ${len}`);
  }
}

// --------------------------------------------------------------------- assertPath
const rejections: [string, string][] = [
  ["", "empty path"],
  ["/abs/path", "leading /"],
  ["a/../b", ".. segment"],
  ["..", "bare .. segment"],
  ["a\\b", "backslash"],
  [`a${String.fromCharCode(0x1f)}b`, "byte 0x1f"],
  ["_leading-underscore", "first byte not [A-Za-z0-9]"],
  ["/leading-slash-and-alnum-after", "leading / (again, alnum follows)"],
];
for (const [bad, label] of rejections) {
  let threw = false;
  try { assertPath(bad); } catch { threw = true; }
  ok(threw, `assertPath rejects: ${label}`, JSON.stringify(bad));
}
{
  // Accepted paths must not throw.
  const good = ["a", "a/b/c.mp4", "0start", "data/chunk-000/file-000.parquet"];
  let allOk = true;
  for (const p of good) {
    try { assertPath(p); } catch { allOk = false; }
  }
  ok(allOk, "assertPath accepts valid relative paths", good.join(", "));
}
{
  // fileLeaf and payloadHash surface the same path-rule rejection.
  let threw = false;
  try { fileLeaf("/bad", keccak256(enc.encode("x")) as Hex); } catch { threw = true; }
  ok(threw, "fileLeaf rejects an invalid path");

  threw = false;
  try {
    payloadHash([{ path: "../escape", bytes: 1, hash: keccak256(enc.encode("x")) as Hex }]);
  } catch { threw = true; }
  ok(threw, "payloadHash rejects an invalid path before touching the filesystem");
}

// --------------------------------------------------------------------- buildFileEntries
async function testBuildFileEntries() {
  const dir = mkdtempSync(join(tmpdir(), "thenar-payload-test-"));
  try {
    writeFileSync(join(dir, "small.txt"), "hello world");
    const sub = join(dir, "nested");
    mkdirSync(sub);
    writeFileSync(join(sub, "file.bin"), Buffer.from([1, 2, 3, 4, 5]));

    const entries = await buildFileEntries(dir, ["small.txt", "nested/file.bin"]);
    ok(entries.length === 2, "buildFileEntries returns one FileEntry per path");
    const small = entries.find((e) => e.path === "small.txt")!;
    ok(small.bytes === 11, "buildFileEntries records the correct byte count", `${small.bytes}`);
    ok(small.hash === (keccak256(enc.encode("hello world")) as Hex),
       "buildFileEntries hashes file content correctly");
    const nested = entries.find((e) => e.path === "nested/file.bin")!;
    ok(nested.hash === (keccak256(Buffer.from([1, 2, 3, 4, 5])) as Hex),
       "buildFileEntries handles nested relative paths");

    // Computing payloadHash from real files must match the in-memory path.
    const expected = payloadHash([
      { path: "small.txt", bytes: 11, hash: keccak256(enc.encode("hello world")) as Hex },
      { path: "nested/file.bin", bytes: 5, hash: keccak256(Buffer.from([1, 2, 3, 4, 5])) as Hex },
    ]);
    ok(payloadHash(entries) === expected, "payloadHash over buildFileEntries output matches the direct computation");

    let threw = false;
    try { await buildFileEntries(dir, ["../escape.txt"]); } catch { threw = true; }
    ok(threw, "buildFileEntries rejects an invalid path before any filesystem access");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  await testHashStreamLengths();
  await testBuildFileEntries();
  console.log(fails === 0 ? "\npayload: all checks passed\n" : `\n${fails} check(s) failed\n`);
  process.exit(fails ? 1 : 0);
}

main();
