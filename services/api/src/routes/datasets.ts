import { Hono } from "hono";
import type { Hex } from "viem";
import type { AppEnv } from "../app.ts";
import { getJsonBody, parseOrThrow } from "../app.ts";
import { requireAuth, requireOwnOrg } from "../auth.ts";
import { ApiError } from "../errors.ts";
import { CreateDatasetBody, IngestDatasetBody } from "../schemas/requests.ts";
import { newUlid } from "../registry.ts";
import { processIngest, putCachedJobResult } from "../ingest/job.ts";

export const datasetRoutes = new Hono<AppEnv>()
  // POST /v1/datasets — org. Every `files[].hash` must already be a stored
  // upload of the caller's org (PLAN §12 binding rule) — else 422 naming
  // the offending hash.
  .post("/datasets", async (c) => {
    const { keyStore, uploadRegistry, logStore } = c.get("deps");
    if (!logStore) throw new ApiError("internal", "log store not configured");
    const principal = requireAuth(keyStore, c.req.header("Authorization"));
    const body = parseOrThrow(CreateDatasetBody, await getJsonBody(c));

    for (const f of body.files) {
      const upload = await uploadRegistry.get(f.hash as Hex);
      if (!upload || upload.status !== "stored" || upload.orgId !== principal.orgId) {
        throw new ApiError("unprocessable", `file ${f.hash} is not a stored upload of this organisation`, { hash: f.hash });
      }
    }

    const datasetId = newUlid();
    const createdAt = Math.floor(Date.now() / 1000);
    logStore.createDataset({
      datasetId,
      orgId: principal.orgId,
      sourceUri: body.source_uri ?? null,
      infoJsonHash: body.info_json_hash as Hex,
      filesJson: JSON.stringify(body.files),
      status: "committed",
      createdAt,
    });

    return c.json(
      {
        dataset_id: datasetId,
        org_id: principal.orgId,
        source_uri: body.source_uri ?? null,
        info_json_hash: body.info_json_hash,
        files: body.files,
        status: "committed",
        created_at: createdAt,
      },
      201,
    );
  })
  // POST /v1/datasets/{id}/ingest — org. Runs the ingest pipeline
  // (`ingest/job.ts`) to completion and records the result as a `job` row
  // (T-014); "async" is satisfied by the `{job_id}` + `GET /jobs/{id}`
  // shape (PLAN §12) — an in-process queue that finishes before responding
  // is a valid instance of that, and keeps this task's tests deterministic.
  .post("/datasets/:id/ingest", async (c) => {
    const { keyStore, logStore, bundleStore, operator, onEpisodeCommitted } = c.get("deps");
    if (!logStore) throw new ApiError("internal", "log store not configured");
    const principal = requireAuth(keyStore, c.req.header("Authorization"));
    const body = parseOrThrow(IngestDatasetBody, await getJsonBody(c));
    const datasetId = c.req.param("id");

    const dataset = logStore.datasetById(datasetId);
    if (!dataset) throw new ApiError("not_found", `dataset ${datasetId} not found`);
    requireOwnOrg(principal, dataset.orgId);
    if (!operator) throw new ApiError("internal", "operator signing key not configured");

    const now = () => Math.floor(Date.now() / 1000);
    const result = await processIngest({
      commitDeps: { store: logStore, now, operator, onEpisodeCommitted },
      bundleStore,
      dataset,
      body: {
        terms_hash: body.terms_hash as Hex,
        scope_bits: body.scope_bits,
        source: body.source,
        consent: { holder: body.consent.holder, pubkey: body.consent.pubkey as Hex, alg: body.consent.alg as "ed25519" | "p256", scope_bits: body.consent.scope_bits },
      },
    });

    const jobId = newUlid();
    const createdAt = now();
    logStore.createJob({
      jobId,
      kind: "ingest",
      status: result.errors.length > 0 && result.episodes.length === 0 ? "error" : "done",
      // The salt lives only on `result.episodes[].salt` returned in this
      // response and cached in-process for `GET /jobs/{id}` — never
      // persisted here (PLAN §10.5).
      payload: JSON.stringify({
        org_id: principal.orgId,
        dataset_id: datasetId,
        episodes: result.episodes.map(({ salt: _salt, ...rest }) => rest),
        errors: result.errors,
      }),
      error: null,
      createdAt,
      updatedAt: createdAt,
    });
    putCachedJobResult(jobId, { orgId: principal.orgId, episodes: result.episodes, errors: result.errors });

    return c.json({ job_id: jobId }, 202);
  });
