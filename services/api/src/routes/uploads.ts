import { Hono } from "hono";
import type { Hex } from "viem";
import type { AppEnv } from "../app.ts";
import { getJsonBody, parseOrThrow } from "../app.ts";
import { requireAuth } from "../auth.ts";
import { ApiError } from "../errors.ts";
import { CreateUploadBody } from "../schemas/requests.ts";
import { HashMismatchError } from "../store/bundle.ts";
import { verifyDownloadToken } from "../store/downloadToken.ts";

const UPLOAD_URL_TTL_S = 15 * 60;

/** Node's raw request body (a web `ReadableStream<Uint8Array>`) as an async iterable, or empty if there is none. */
function bodyStream(c: import("hono").Context<AppEnv>): AsyncIterable<Uint8Array> {
  const body = c.req.raw.body;
  if (!body) return (async function* () {})();
  return body as unknown as AsyncIterable<Uint8Array>;
}

export const uploadRoutes = new Hono<AppEnv>()
  // POST /v1/uploads — org. Presigns (S3) or points at the local PUT target.
  .post("/uploads", async (c) => {
    const { keyStore, bundleStore, uploadRegistry } = c.get("deps");
    const principal = requireAuth(keyStore, c.req.header("Authorization"));
    const body = parseOrThrow(CreateUploadBody, await getJsonBody(c));
    const hash = body.hash as Hex;

    if (await bundleStore.has(hash)) {
      // The content is already in the bundle store (persisted separately
      // from `uploadRegistry`, which is per-process/in-memory) — attribute
      // it to *this* caller's org before marking it stored, the same way
      // the pending-upload branch below does. Without this, a caller
      // hitting the store's content-addressed cache on a process that has
      // never seen this hash before gets a registry row with no org
      // (`markStored` on an unknown hash defaults `orgId: ""`), and every
      // later `orgId` check (e.g. `POST /episodes`, `POST /datasets`)
      // then wrongly refuses it as "not a stored upload of this
      // organisation".
      await uploadRegistry.putPending(hash, body.bytes, principal.orgId);
      await uploadRegistry.markStored(hash);
      return c.json({ stored: true });
    }

    // Duplicate concurrent uploads of the same hash share one pending row;
    // both callers get a (possibly re-issued) PUT target for the same
    // content, and the store's `put` is idempotent on the winner.
    await uploadRegistry.putPending(hash, body.bytes, principal.orgId);

    const expiresAt = Math.floor(Date.now() / 1000) + UPLOAD_URL_TTL_S;
    const url = bundleStore.signedPutUrl
      ? await bundleStore.signedPutUrl(hash, body.bytes, UPLOAD_URL_TTL_S)
      : `/v1/uploads/${hash}`;

    return c.json({ hash, method: "PUT", url, expires_at: expiresAt });
  })
  // PUT /v1/uploads/{hash} — org, local store only. Streams the body into the store.
  .put("/uploads/:hash", async (c) => {
    const { keyStore, bundleStore, uploadRegistry } = c.get("deps");
    const principal = requireAuth(keyStore, c.req.header("Authorization"));
    const hash = c.req.param("hash") as Hex;

    if (await bundleStore.has(hash)) {
      // Idempotent: drain the body (if any) and report success without
      // re-reading. Same org-attribution fix as POST /uploads above —
      // `body.bytes` is not known here, so 0 is recorded if a fresh
      // pending row must be created; harmless, since `bundleStore` (not
      // this row) is the source of truth for the content's actual size.
      for await (const _chunk of bodyStream(c)) {
        /* discard */
      }
      await uploadRegistry.putPending(hash, 0, principal.orgId);
      await uploadRegistry.markStored(hash);
      return c.json({ stored: true }, 201);
    }

    const contentLengthHeader = c.req.header("Content-Length");
    const bytes = contentLengthHeader ? Number(contentLengthHeader) : undefined;
    if (bytes === undefined || !Number.isInteger(bytes) || bytes < 0) {
      throw new ApiError("invalid_request", "PUT /v1/uploads/{hash} requires a Content-Length header");
    }

    try {
      await bundleStore.put(hash, bodyStream(c), bytes);
    } catch (err) {
      if (err instanceof HashMismatchError) {
        throw new ApiError("unprocessable", err.message, { reason: "hash_mismatch" });
      }
      throw err;
    }

    await uploadRegistry.markStored(hash);
    return c.json({ stored: true }, 201);
  })
  // POST /v1/uploads/{hash}/complete — org, S3 store only. Verifies the presigned-PUT'd object by streaming it back through hashStream.
  .post("/uploads/:hash/complete", async (c) => {
    const { keyStore, bundleStore, uploadRegistry } = c.get("deps");
    requireAuth(keyStore, c.req.header("Authorization"));
    const hash = c.req.param("hash") as Hex;

    const verify = (bundleStore as { verify?: (hash: Hex) => Promise<boolean> }).verify;
    if (typeof verify !== "function") {
      throw new ApiError("not_implemented", "upload completion is only meaningful for the S3 store");
    }

    const ok = await verify.call(bundleStore, hash);
    if (!ok) {
      throw new ApiError("unprocessable", `object for hash ${hash} failed verification`, { reason: "hash_mismatch" });
    }

    await uploadRegistry.markStored(hash);
    return c.json({ stored: true });
  })
  // GET /v1/uploads/{hash}?exp=&t= — signed delivery target for the local store (§14: short-lived signed URLs).
  .get("/uploads/:hash", async (c) => {
    const { bundleStore } = c.get("deps");
    const hash = c.req.param("hash") as Hex;
    const expParam = c.req.query("exp");
    const token = c.req.query("t");
    const secret = process.env.UPLOAD_TOKEN_SECRET ?? "dev-insecure-upload-secret";

    const expiresAt = expParam ? Number(expParam) : NaN;
    if (!token || !Number.isInteger(expiresAt)) {
      throw new ApiError("unauthorized", "missing or malformed signed download token");
    }
    if (!verifyDownloadToken(hash, expiresAt, token, secret)) {
      throw new ApiError("unauthorized", "signed download token is invalid or expired");
    }

    if (!(await bundleStore.has(hash))) {
      // I-11 / §27 trap 18 — never substitute a placeholder for a missing object.
      throw new ApiError("internal", `stored object missing for hash ${hash}`);
    }

    const stream = await bundleStore.open(hash);
    return new Response(stream, { status: 200, headers: { "content-type": "application/octet-stream" } });
  });
