import { Hono } from "hono";
import type { AppEnv } from "../app.ts";
import { notImplemented } from "../app.ts";

export const proofRoutes = new Hono<AppEnv>()
  // GET /v1/proofs/inclusion?leaf=&root=&size= — public
  .get("/proofs/inclusion", (c) => notImplemented("inclusion proof"))
  // GET /v1/proofs/consistency?from_size=&to_size= — public
  .get("/proofs/consistency", (c) => notImplemented("consistency proof"));
