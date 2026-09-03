import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { requireAuth } from "../auth.ts";
import { ApiError } from "../errors.ts";
import { getCachedJobResult } from "../ingest/job.ts";

export const jobRoutes = new Hono<AppEnv>()
  // GET /v1/jobs/{jobId} — org. PLAN §12/TASK-036.md: `{status, episodes:
  // [{episode_index, leaf_hash, leaf_index, submitted_at, receipt, salt}],
  // errors:[{episode_index, code, message}]}`.
  .get("/jobs/:jobId", (c) => {
    const { keyStore, logStore } = c.get("deps");
    if (!logStore) throw new ApiError("internal", "log store not configured");
    const principal = requireAuth(keyStore, c.req.header("Authorization"));
    const jobId = c.req.param("jobId");

    const row = logStore.jobById(jobId);
    if (!row) throw new ApiError("not_found", `job ${jobId} not found`);

    const cached = getCachedJobResult(jobId);
    if (!cached) {
      // The salt-bearing result lives only in this process's memory (PLAN
      // §10.5 — never persisted); a job whose result fell out of that
      // cache (process restart) has nothing safe to report back other
      // than its status. I-11: never fabricate the missing episodes/errors.
      throw new ApiError("internal", `job ${jobId} result is no longer available in this process`);
    }
    if (cached.orgId !== principal.orgId) {
      throw new ApiError("forbidden", "may only act on its own organisation's rows");
    }

    return c.json({ status: row.status, episodes: cached.episodes, errors: cached.errors });
  });
