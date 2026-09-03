import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { getJsonBody, parseOrThrow, notImplemented } from "../app.ts";
import { requireAuth } from "../auth.ts";
import { CorpusManifestInput } from "../schemas/corpusManifest.ts";

export const corpusRoutes = new Hono<AppEnv>()
  // POST /v1/corpora — org
  .post("/corpora", async (c) => {
    const { keyStore } = c.get("deps");
    requireAuth(keyStore, c.req.header("Authorization"));
    const body = parseOrThrow(CorpusManifestInput, await getJsonBody(c));
    return notImplemented(`create corpus "${body.title}"`);
  })
  // POST /v1/corpora/{id}/log — org
  .post("/corpora/:id/log", (c) => {
    const { keyStore } = c.get("deps");
    requireAuth(keyStore, c.req.header("Authorization"));
    return notImplemented(`log corpus ${c.req.param("id")}`);
  })
  // GET /v1/corpora/{id}/seal-params — org
  .get("/corpora/:id/seal-params", (c) => {
    const { keyStore } = c.get("deps");
    requireAuth(keyStore, c.req.header("Authorization"));
    return notImplemented(`seal params for corpus ${c.req.param("id")}`);
  })
  // GET /v1/corpora/{id} — public
  .get("/corpora/:id", (c) => notImplemented(`corpus ${c.req.param("id")}`))
  // GET /v1/corpora/{id}/report?format= — public
  .get("/corpora/:id/report", (c) => notImplemented(`report for corpus ${c.req.param("id")}`));
