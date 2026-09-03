import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { getJsonBody, parseOrThrow, notImplemented } from "../app.ts";
import { ApiError } from "../errors.ts";
import { RevokeConsentBody } from "../schemas/requests.ts";

export const consentRoutes = new Hono<AppEnv>()
  // GET /v1/consent/{consentKey}?root=&size= — public
  .get("/consent/:consentKey", (c) => notImplemented(`consent status for ${c.req.param("consentKey")}`))
  // POST /v1/consent/{consentKey}/revoke — public, rate-limited 60/min/IP
  .post("/consent/:consentKey/revoke", async (c) => {
    const { rateLimiter } = c.get("deps");
    const ip =
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
      c.req.header("x-real-ip") ||
      "unknown";
    if (!rateLimiter.allow(ip)) {
      throw new ApiError("rate_limited", "too many revoke requests from this IP");
    }
    const body = parseOrThrow(RevokeConsentBody, await getJsonBody(c));
    return notImplemented(`revoke consent ${c.req.param("consentKey")} (holder ${body.record.holder})`);
  });
