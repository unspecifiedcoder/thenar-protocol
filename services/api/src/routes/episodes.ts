import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { getJsonBody, parseOrThrow, notImplemented } from "../app.ts";
import { requireAuth } from "../auth.ts";
import { CreateEpisodeBody } from "../schemas/requests.ts";

export const episodeRoutes = new Hono<AppEnv>()
  // POST /v1/episodes — org; §9.1 validated, §10.4 payload_hash recomputed by the real handler
  .post("/episodes", async (c) => {
    const { keyStore } = c.get("deps");
    requireAuth(keyStore, c.req.header("Authorization"));
    const body = parseOrThrow(CreateEpisodeBody, await getJsonBody(c));
    return notImplemented(`log episode for org ${body.manifest.org_id}`);
  })
  // GET /v1/episodes/{leafHash} — public
  .get("/episodes/:leafHash", (c) => notImplemented(`episode detail for ${c.req.param("leafHash")}`));
