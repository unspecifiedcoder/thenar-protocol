import { Hono } from "hono";
import type { Hex } from "viem";
import type { AppEnv } from "../app.ts";
import { getJsonBody, parseOrThrow } from "../app.ts";
import { requireAuth, requireOwnOrg } from "../auth.ts";
import { CreateKeyBody } from "../schemas/requests.ts";
import { toPublicSigningKey } from "../registry.ts";
import { paginated } from "../pagination.ts";

export const orgRoutes = new Hono<AppEnv>()
  // POST /v1/orgs/{orgId}/keys — org
  .post("/orgs/:orgId/keys", async (c) => {
    const { keyStore, registry } = c.get("deps");
    const principal = requireAuth(keyStore, c.req.header("Authorization"));
    const orgId = c.req.param("orgId");
    requireOwnOrg(principal, orgId);
    const body = parseOrThrow(CreateKeyBody, await getJsonBody(c));
    const row = registry.registerKey(orgId, { alg: body.alg, pubkey: body.pubkey as Hex, attestation: body.attestation });
    return c.json(toPublicSigningKey(row), 201);
  })
  // GET /v1/orgs/{orgId}/keys — public
  .get("/orgs/:orgId/keys", (c) => {
    const { registry } = c.get("deps");
    const orgId = c.req.param("orgId");
    return c.json(paginated(registry.listKeys(orgId), null));
  })
  // POST /v1/orgs/{orgId}/keys/{keyId}/revoke — org
  .post("/orgs/:orgId/keys/:keyId/revoke", async (c) => {
    const { keyStore, registry } = c.get("deps");
    const principal = requireAuth(keyStore, c.req.header("Authorization"));
    const orgId = c.req.param("orgId");
    requireOwnOrg(principal, orgId);
    const row = registry.revokeKey(orgId, c.req.param("keyId") as Hex);
    return c.json(toPublicSigningKey(row));
  });
