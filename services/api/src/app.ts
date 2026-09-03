/**
 * `services/api` — Hono app factory. PLAN §12 lists every route this app
 * must expose; every one of them (other than `/v1/healthz` and, since
 * T-024, the `/v1/orgs/{orgId}/keys*` trio) validates its body against the
 * matching §9/§12 zod schema and then answers 501 `not_implemented`, so
 * the shape of the API is real before any handler has a store behind it
 * (I-11: the service never invents a value, and a stub that fabricates a
 * 200 would be exactly that).
 */
import { Hono, type Context } from "hono";
import type { ZodTypeAny } from "zod";
import { ApiError, errorBody, statusOf } from "./errors.ts";
import { KeyStore } from "./auth.ts";
import { MemoryIdempotencyStore, withIdempotency, type IdempotencyStore } from "./idempotency.ts";
import { TokenBucketLimiter } from "./ratelimit.ts";
import type { BundleStore } from "./store/bundle.ts";
import { LocalBundleStore } from "./store/localBundleStore.ts";
import { MemoryUploadRegistry, type UploadRegistry } from "./store/uploadRegistry.ts";
import { NotImplementedChainReader, type ChainReader } from "./chainReader.ts";
import { Registry } from "./registry.ts";
import { LogStore } from "../../log/src/store.ts";
import {
  metricsRegistry, apiErrorsTotalCounter, claimsTotalCounter, revocationsTotalCounter,
} from "./metrics.ts";

import { healthRoutes } from "./routes/health.ts";
import { orgRoutes } from "./routes/orgs.ts";
import { uploadRoutes } from "./routes/uploads.ts";
import { datasetRoutes } from "./routes/datasets.ts";
import { jobRoutes } from "./routes/jobs.ts";
import { episodeRoutes } from "./routes/episodes.ts";
import { proofRoutes } from "./routes/proofs.ts";
import { consentRoutes } from "./routes/consent.ts";
import { corpusRoutes } from "./routes/corpora.ts";
import { claimRoutes } from "./routes/claims.ts";
import { anchorRoutes } from "./routes/anchors.ts";
import { licenceRoutes } from "./routes/licences.ts";

export type Deps = {
  keyStore: KeyStore;
  idempotencyStore: IdempotencyStore;
  rateLimiter: TokenBucketLimiter;
  /** unix-minute clock, overridable in tests */
  nowMinute: () => number;
  /** T-015: content-addressed bundle store (PLAN §14). */
  bundleStore: BundleStore;
  /** T-015: `Upload` rows (PLAN §8), in-memory until T-014's SQLite table backs this. */
  uploadRegistry: UploadRegistry;
  /** T-015 injection point for T-016's real viem reader (PLAN §12 `/licences/{id}/download`). */
  chainReader: ChainReader;
  /** T-024: org/signing-key registry, backed by the `org`/`api_key`/`signing_key` tables. */
  registry: Registry;
};

export type AppEnv = { Variables: { deps: Deps; parsedBody?: { value: unknown } } };
export type AppContext = Context<AppEnv>;

export function defaultDeps(env: NodeJS.ProcessEnv = process.env): Deps {
  // T-024: `THENAR_LOG_DB` set -> the `api_key`/`signing_key` tables are the
  // auth source and the registry's backing store; unset -> an in-memory
  // store backs the registry (so the org routes still work) but auth keeps
  // reading `API_KEYS_JSON`, same as before this task (kept for tests).
  const dbPath = env.THENAR_LOG_DB;
  const logStore = new LogStore(dbPath ?? ":memory:");
  return {
    keyStore: dbPath
      ? new KeyStore([], logStore)
      : new KeyStore(env.API_KEYS_JSON ? JSON.parse(env.API_KEYS_JSON) : []),
    idempotencyStore: new MemoryIdempotencyStore(),
    rateLimiter: new TokenBucketLimiter(),
    nowMinute: () => Math.floor(Date.now() / 60_000),
    bundleStore: new LocalBundleStore(env.BUNDLE_STORE_ROOT ?? ".data/bundles"),
    uploadRegistry: new MemoryUploadRegistry(),
    // T-016 supplies the real viem reader; until then, refuse rather than fabricate (I-11).
    chainReader: new NotImplementedChainReader(),
    registry: new Registry(logStore),
  };
}

/** Reads and JSON-parses the request body exactly once per request, however many handlers ask for it. */
export async function getJsonBody(c: AppContext): Promise<unknown> {
  const cached = c.get("parsedBody");
  if (cached) return cached.value;
  let value: unknown = null;
  try {
    value = await c.req.json();
  } catch {
    value = null;
  }
  c.set("parsedBody", { value });
  return value;
}

/** Validates `body` against `schema`; throws `invalid_request` with zod issues in `details` on failure. */
export function parseOrThrow<T extends ZodTypeAny>(schema: T, body: unknown): ReturnType<T["parse"]> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw new ApiError("invalid_request", "request body failed validation", result.error.issues);
  }
  return result.data;
}

export function notImplemented(message: string): never {
  throw new ApiError("not_implemented", message);
}

function errorToResponseParts(err: unknown): { status: number; body: unknown } {
  if (err instanceof ApiError) {
    return { status: statusOf(err.code), body: errorBody(err.code, err.message, err.details) };
  }
  throw err;
}

export function createApp(deps: Deps = defaultDeps()) {
  const app = new Hono<AppEnv>();

  app.use("*", async (c, next) => {
    c.set("deps", deps);
    await next();
  });

  // Metrics middleware (T-031): track error responses by HTTP status code
  app.use("/v1/*", async (c, next) => {
    await next();
    if (c.res.status >= 400) {
      apiErrorsTotalCounter.inc({ code: String(c.res.status) });
    }
  });

  // Idempotency (PLAN §12): every POST under /v1 replays on a repeated
  // `Idempotency-Key` with the same body, and 409s on the same key with a
  // different body. Applied generically so no route can forget it. The
  // wrapped result — success or a thrown ApiError alike — is what gets
  // stored and replayed, so a stub's 501 is idempotent too.
  app.use("/v1/*", async (c, next) => {
    if (c.req.method !== "POST") return next();
    const key = c.req.header("Idempotency-Key");
    if (!key) return next();
    const scopedKey = `${new URL(c.req.url).pathname}::${key}`;
    const rawBody = await getJsonBody(c);
    const { status, body } = await withIdempotency(deps.idempotencyStore, scopedKey, rawBody, async () => {
      try {
        await next();
        const res = c.res;
        const text = res ? await res.clone().text() : "";
        let parsedBody: unknown = null;
        try {
          parsedBody = text ? JSON.parse(text) : null;
        } catch {
          parsedBody = text;
        }
        return { status: res?.status ?? 200, body: parsedBody };
      } catch (err) {
        return errorToResponseParts(err);
      }
    });
    c.res = new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });

  // Metrics endpoint (T-031): served only from localhost or with METRICS_TOKEN
  app.get("/v1/metrics", async (c) => {
    const token = process.env.METRICS_TOKEN;
    const authHeader = c.req.header("Authorization");
    const isLocalhost = c.req.header("x-forwarded-for") === undefined || c.req.header("x-forwarded-for") === "127.0.0.1";

    const authorized = isLocalhost || (token && authHeader === `Bearer ${token}`);
    if (!authorized) {
      return c.text("Unauthorized", 401);
    }

    const metrics = await metricsRegistry.metrics();
    return c.text(metrics, 200, { "content-type": "text/plain; version=0.0.4; charset=utf-8" });
  });

  app.route("/v1", healthRoutes);
  app.route("/v1", orgRoutes);
  app.route("/v1", uploadRoutes);
  app.route("/v1", datasetRoutes);
  app.route("/v1", jobRoutes);
  app.route("/v1", episodeRoutes);
  app.route("/v1", proofRoutes);
  app.route("/v1", consentRoutes);
  app.route("/v1", corpusRoutes);
  app.route("/v1", claimRoutes);
  app.route("/v1", anchorRoutes);
  app.route("/v1", licenceRoutes);

  app.onError((err, c) => {
    if (err instanceof ApiError) {
      return c.json(errorBody(err.code, err.message, err.details), statusOf(err.code) as 400);
    }
    console.error(err);
    return c.json(errorBody("internal", "internal error"), 500);
  });

  app.notFound((c) => c.json(errorBody("not_found", "no such route"), 404));

  return app;
}
