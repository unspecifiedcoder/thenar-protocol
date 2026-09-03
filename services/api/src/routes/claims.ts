import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { getJsonBody, parseOrThrow, notImplemented } from "../app.ts";
import { requireAuth, requireRole } from "../auth.ts";
import { VerificationClaim } from "../schemas/verificationClaim.ts";

export const claimRoutes = new Hono<AppEnv>()
  // POST /v1/claims — verifier only
  .post("/claims", async (c) => {
    const { keyStore } = c.get("deps");
    const principal = requireAuth(keyStore, c.req.header("Authorization"));
    requireRole(principal, "verifier");
    const body = parseOrThrow(VerificationClaim, await getJsonBody(c));
    return notImplemented(`log verification claim for ${body.subject_leaf}`);
  });
