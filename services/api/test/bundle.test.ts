/**
 * T-015 — `LocalBundleStore`: hash-mismatch rejection, idempotent `put`,
 * and a streamed 100 MB fixture that stays within a bounded memory delta
 * (never buffered whole in the process).
 */
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256 } from "viem";
import { LocalBundleStore } from "../src/store/localBundleStore.ts";
import { HashMismatchError } from "../src/store/bundle.ts";

let fails = 0;
const ok = (c: boolean, m: string, x = "") => { if (!c) fails++; console.log(`${c ? "  ok  " : " FAIL "} ${m}${x ? ` — ${x}` : ""}`); };

function newStore(): { store: LocalBundleStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), "thenar-bundle-test-"));
  return { store: new LocalBundleStore(root), root };
}

async function* bytesOf(buf: Buffer, chunkSize = 64 * 1024): AsyncIterable<Uint8Array> {
  for (let i = 0; i < buf.length; i += chunkSize) {
    yield buf.subarray(i, Math.min(i + chunkSize, buf.length));
  }
}

// =========================================================================
// Hash mismatch: rejected, temp file removed, real object never appears.
// =========================================================================
{
  const { store, root } = newStore();
  const content = Buffer.from("the real content of this object");
  const wrongHash = "0x" + "11".repeat(32) as `0x${string}`;

  let threw: unknown;
  try {
    await store.put(wrongHash, bytesOf(content), content.length);
  } catch (e) {
    threw = e;
  }
  ok(threw instanceof HashMismatchError, "put() with a wrong hash throws HashMismatchError");
  ok(!(await store.has(wrongHash)), "the mismatched object is not stored");

  const leftover = readdirSync(root).filter((f) => f.startsWith(".tmp-"));
  ok(leftover.length === 0, "no temp file is left behind after a mismatch", JSON.stringify(leftover));

  // Byte-length mismatch (right hash of a truncated body, wrong claimed length) is also rejected.
  const realHash = keccak256(`0x${content.toString("hex")}`);
  let lengthThrew: unknown;
  try {
    await store.put(realHash, bytesOf(content), content.length + 1);
  } catch (e) {
    lengthThrew = e;
  }
  ok(lengthThrew instanceof HashMismatchError, "put() with a wrong declared length throws HashMismatchError");
  ok(!(await store.has(realHash)), "a length-mismatched object is not stored");

  await rm(root, { recursive: true, force: true });
}

// =========================================================================
// Idempotent put: a second put() of the same (correct) hash is a no-op.
// =========================================================================
{
  const { store, root } = newStore();
  const content = Buffer.from("idempotent object content");
  const hash = keccak256(`0x${content.toString("hex")}`);

  await store.put(hash, bytesOf(content), content.length);
  ok(await store.has(hash), "first put() stores the object");

  // A second put — even with different (wrong) bytes for the same hash — is skipped entirely since the object already exists.
  await store.put(hash, bytesOf(Buffer.from("would not matter")), content.length);
  ok(await store.has(hash), "object still present after a repeat put()");

  const stream = await store.open(hash);
  const chunks: Buffer[] = [];
  for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) chunks.push(Buffer.from(chunk));
  ok(Buffer.concat(chunks).equals(content), "the original content is unchanged by the repeat put()");

  await rm(root, { recursive: true, force: true });
}

// =========================================================================
// A 100 MB streamed fixture, generated deterministically in memory (never
// committed to disk as a file), stays within a bounded RSS delta.
// =========================================================================
{
  const { store, root } = newStore();
  const SIZE = 100 * 1024 * 1024;
  const CHUNK = 1024 * 1024;

  // Deterministic generator: no 100 MB buffer ever held at once.
  async function* generate(size: number, chunkSize: number): AsyncIterable<Uint8Array> {
    let produced = 0;
    let seed = 0x9e3779b9;
    while (produced < size) {
      const n = Math.min(chunkSize, size - produced);
      const chunk = Buffer.allocUnsafe(n);
      for (let i = 0; i < n; i++) {
        seed = (seed * 1103515245 + 12345) & 0xffffffff;
        chunk[i] = seed & 0xff;
      }
      produced += n;
      yield chunk;
    }
  }

  // Hash the fixture once up front (same generator, same seed -> identical bytes) to get the expected key.
  const { hashStream } = await import("../../../packages/protocol/src/payload.ts");
  const expectedHash = await hashStream(generate(SIZE, CHUNK));

  if (global.gc) global.gc();
  const rssBefore = process.memoryUsage().rss;

  await store.put(expectedHash, generate(SIZE, CHUNK), SIZE);

  if (global.gc) global.gc();
  const rssAfter = process.memoryUsage().rss;
  const deltaMB = (rssAfter - rssBefore) / (1024 * 1024);

  ok(await store.has(expectedHash), "the 100 MB fixture is stored");
  ok(deltaMB < 200, `RSS delta while streaming a 100 MB fixture stays under 200 MB (was ${deltaMB.toFixed(1)} MB)`, `${deltaMB.toFixed(1)} MB`);

  await rm(root, { recursive: true, force: true });
}

console.log(fails === 0 ? "\nall bundle store tests passed\n" : `\n${fails} bundle store test(s) failed\n`);
process.exit(fails ? 1 : 0);
