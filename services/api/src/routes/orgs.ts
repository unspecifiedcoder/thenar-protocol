import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { getJsonBody, parseOrThrow, notImplemented } from "../app.ts";
import { requireAuth, requireOwnOrg } from "../auth.ts";
import { CreateKeyBody } from "../schemas/requests.ts";

export const orgRoutes = new Hono<AppEnv>()
  // POST /v1/orgs/{orgId}/keys — org
  .post("/orgs/:orgId/keys", async (c) => {
    const { keyStore } = c.get("deps");
    const principal = requireAuth(keyStore, c.req.header("Authorization"));
    requireOwnOrg(principal, c.req.param("orgId"));
    const body = parseOrThrow(CreateKeyBody, await getJsonBody(c));
    return notImplemented(`create signing key for org ${c.req.param("orgId")} (alg ${body.alg})`);
  })
  // GET /v1/orgs/{orgId}/keys — public
  .get("/orgs/:orgId/keys", (c) => notImplemented(`list signing keys for org ${c.req.param("orgId")}`))
  // POST /v1/orgs/{orgId}/keys/{keyId}/revoke — org
  .post("/orgs/:orgId/keys/:keyId/revoke", async (c) => {
    const { keyStore } = c.get("deps");
    const principal = requireAuth(keyStore, c.req.header("Authorization"));
    requireOwnOrg(principal, c.req.param("orgId"));
    return notImplemented(`revoke key ${c.req.param("keyId")} for org ${c.req.param("orgId")}`);
  });
