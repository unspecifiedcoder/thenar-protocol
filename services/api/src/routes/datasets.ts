import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { getJsonBody, parseOrThrow, notImplemented } from "../app.ts";
import { requireAuth } from "../auth.ts";
import { CreateDatasetBody, IngestDatasetBody } from "../schemas/requests.ts";

export const datasetRoutes = new Hono<AppEnv>()
  // POST /v1/datasets — org
  .post("/datasets", async (c) => {
    const { keyStore } = c.get("deps");
    requireAuth(keyStore, c.req.header("Authorization"));
    parseOrThrow(CreateDatasetBody, await getJsonBody(c));
    return notImplemented("create dataset");
  })
  // POST /v1/datasets/{id}/ingest — org
  .post("/datasets/:id/ingest", async (c) => {
    const { keyStore } = c.get("deps");
    requireAuth(keyStore, c.req.header("Authorization"));
    parseOrThrow(IngestDatasetBody, await getJsonBody(c));
    return notImplemented(`ingest dataset ${c.req.param("id")}`);
  });
