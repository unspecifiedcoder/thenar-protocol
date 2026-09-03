/**
 * Compute payloadHash (PLAN §10.4) over every file under a directory.
 *
 *   pnpm payload <dir>
 *
 * Prints the `files[]` (FileEntry) array and the resulting hash as JSON.
 * Paths are relative to `<dir>`, `/`-separated (§9.1).
 */
import { readdir } from "node:fs/promises";
import { relative, sep } from "node:path";
import { buildFileEntries, payloadHash } from "./payload.ts";

async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile())
    .map((e) => {
      const parent = (e as unknown as { parentPath?: string; path?: string }).parentPath
        ?? (e as unknown as { path?: string }).path
        ?? dir;
      const abs = `${parent}${sep}${e.name}`;
      return relative(dir, abs).split(sep).join("/");
    });
}

async function main() {
  const dir = process.argv[2];
  if (!dir) {
    console.error("usage: pnpm payload <dir>");
    process.exit(1);
  }
  const relPaths = (await listFiles(dir)).sort();
  const files = await buildFileEntries(dir, relPaths);
  const hash = payloadHash(files);
  console.log(JSON.stringify({ files, hash }, null, 2));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
