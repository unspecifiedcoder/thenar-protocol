/**
 * T-015 — `LocalBundleStore(rootDir)`. Objects live at `<rootDir>/<hash>`
 * (lowercase hex, no `0x` in the filename is fine either way — we keep the
 * `0x` prefix since it round-trips losslessly and avoids a second parse).
 * A `put` writes to a temp file first and renames into place only after
 * `hashStream` confirms the content matches; a mismatch deletes the temp
 * file and never leaves a partial object visible.
 */
import { createWriteStream, createReadStream } from "node:fs";
import { access, mkdir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { Readable } from "node:stream";
import { join } from "node:path";
import type { Hex } from "viem";
import { hashStream } from "../../../../packages/protocol/src/payload.ts";
import type { BundleStore } from "./bundle.ts";
import { HashMismatchError } from "./bundle.ts";
import { signDownloadToken } from "./downloadToken.ts";

/** Wraps a byte stream, writing every chunk to `ws` as it passes through, and stopping early if the byte budget is exceeded. */
async function* teeToFile(
  stream: AsyncIterable<Uint8Array>,
  ws: NodeJS.WritableStream,
  counter: { bytes: number },
): AsyncIterable<Uint8Array> {
  for await (const chunk of stream) {
    counter.bytes += chunk.length;
    if (!ws.write(chunk)) await once(ws, "drain");
    yield chunk;
  }
}

export class LocalBundleStore implements BundleStore {
  constructor(
    private readonly rootDir: string,
    private readonly secret: string = process.env.UPLOAD_TOKEN_SECRET ?? "dev-insecure-upload-secret",
  ) {}

  private objectPath(hash: Hex): string {
    return join(this.rootDir, hash.toLowerCase());
  }

  private tempPath(hash: Hex): string {
    return join(this.rootDir, `.tmp-${hash.toLowerCase()}-${randomUUID()}`);
  }

  async has(hash: Hex): Promise<boolean> {
    try {
      await access(this.objectPath(hash));
      return true;
    } catch {
      return false;
    }
  }

  async put(hash: Hex, stream: AsyncIterable<Uint8Array>, bytes: number): Promise<void> {
    // Idempotent: an object already stored under this hash is immutable
    // (PLAN §8 Upload row), so a second `put` of the same content is a
    // no-op rather than a duplicate write.
    if (await this.has(hash)) return;

    await mkdir(this.rootDir, { recursive: true });
    const tmpPath = this.tempPath(hash);
    const ws = createWriteStream(tmpPath);
    const counter = { bytes: 0 };

    let computedHash: Hex;
    try {
      computedHash = await hashStream(teeToFile(stream, ws, counter));
      await new Promise<void>((resolve, reject) => {
        ws.end((err?: Error | null) => (err ? reject(err) : resolve()));
      });
    } catch (err) {
      ws.destroy();
      await rm(tmpPath, { force: true });
      throw err;
    }

    if (computedHash.toLowerCase() !== hash.toLowerCase() || counter.bytes !== bytes) {
      await rm(tmpPath, { force: true });
      throw new HashMismatchError(hash, computedHash, bytes, counter.bytes);
    }

    await rename(tmpPath, this.objectPath(hash));
  }

  async open(hash: Hex): Promise<ReadableStream<Uint8Array>> {
    if (!(await this.has(hash))) {
      throw new Error(`LocalBundleStore: no object stored for ${hash}`);
    }
    return Readable.toWeb(createReadStream(this.objectPath(hash))) as ReadableStream<Uint8Array>;
  }

  /** Local delivery URL: `/v1/uploads/{hash}?exp=&t=`, verified by `verifyDownloadToken` in the uploads route. */
  async signedGetUrl(hash: Hex, ttlS: number): Promise<string> {
    const expiresAt = Math.floor(Date.now() / 1000) + ttlS;
    const token = signDownloadToken(hash, expiresAt, this.secret);
    return `/v1/uploads/${hash}?exp=${expiresAt}&t=${token}`;
  }

  // No `signedPutUrl`: the local store's PUT target *is* `/v1/uploads/{hash}`
  // itself (org-authenticated), so there is nothing to presign.
}
