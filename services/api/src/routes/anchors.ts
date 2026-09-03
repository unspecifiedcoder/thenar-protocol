import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { notImplemented } from "../app.ts";

export const anchorRoutes = new Hono<AppEnv>()
  // GET /v1/anchors — public
  .get("/anchors", (c) => notImplemented("list anchors"))
  // GET /v1/anchors/audit — public
  .get("/anchors/audit", (c) => notImplemented("anchor audit"));
