import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { notImplemented } from "../app.ts";
import { requireAuth } from "../auth.ts";

export const jobRoutes = new Hono<AppEnv>()
  // GET /v1/jobs/{jobId} — org
  .get("/jobs/:jobId", (c) => {
    const { keyStore } = c.get("deps");
    requireAuth(keyStore, c.req.header("Authorization"));
    return notImplemented(`job status for ${c.req.param("jobId")}`);
  });
