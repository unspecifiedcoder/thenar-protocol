/**
 * T-015 — `S3BundleStore`. `POST /v1/uploads` hands the caller a presigned
 * PUT URL (`signedPutUrl`) so the bytes go straight to S3, never through
 * this process; the caller then confirms with `POST
 * /v1/uploads/{hash}/complete`, which calls `verify(hash)` to stream the
 * object back through `hashStream` and confirm it really is what its key
 * claims before the upload row flips `pending` -> `stored`.
 *
 * `put()` still exists to satisfy `BundleStore` (e.g. for tooling that
 * writes directly rather than via a presigned URL): it uploads the stream
 * and then runs the same `verify` before treating the write as done,
 * deleting the object on a mismatch rather than leaving a bad object
 * addressable by the wrong hash.
 */
import { Readable } from "node:stream";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Hex } from "viem";
import { hashStream } from "../../../../packages/protocol/src/payload.ts";
import type { BundleStore } from "./bundle.ts";
import { HashMismatchError } from "./bundle.ts";

export class S3BundleStore implements BundleStore {
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    private readonly prefix = "",
    client?: S3Client,
  ) {
    this.client = client ?? new S3Client({});
  }

  private key(hash: Hex): string {
    return `${this.prefix}${hash.toLowerCase()}`;
  }

  async has(hash: Hex): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: this.key(hash) }));
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async put(hash: Hex, stream: AsyncIterable<Uint8Array>, bytes: number): Promise<void> {
    if (await this.has(hash)) return;
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.key(hash),
        Body: Readable.from(stream),
        ContentLength: bytes,
      }),
    );
    const ok = await this.verify(hash);
    if (!ok) {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: this.key(hash) }));
      throw new HashMismatchError(hash, "0x" as Hex, bytes, -1);
    }
  }

  async open(hash: Hex): Promise<ReadableStream<Uint8Array>> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(hash) }));
    const body = res.Body as { transformToWebStream?: () => ReadableStream<Uint8Array> } | undefined;
    if (!body?.transformToWebStream) {
      throw new Error(`S3BundleStore: no readable body for ${hash}`);
    }
    return body.transformToWebStream();
  }

  async signedGetUrl(hash: Hex, ttlS: number): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: this.key(hash) }), {
      expiresIn: ttlS,
    });
  }

  async signedPutUrl(hash: Hex, bytes: number, ttlS: number): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({ Bucket: this.bucket, Key: this.key(hash), ContentLength: bytes }),
      { expiresIn: ttlS },
    );
  }

  /** Streams the stored object back through `hashStream` and confirms it hashes to `hash`. False if the object is missing or mismatched. */
  async verify(hash: Hex): Promise<boolean> {
    let res;
    try {
      res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: this.key(hash) }));
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
    const body = res.Body as AsyncIterable<Uint8Array> | undefined;
    if (!body) return false;
    const computed = await hashStream(body);
    return computed.toLowerCase() === hash.toLowerCase();
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } } | undefined;
  return e?.name === "NotFound" || e?.name === "NoSuchKey" || e?.$metadata?.httpStatusCode === 404;
}
