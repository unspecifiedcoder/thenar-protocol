/** `pnpm dev:api` entry point — serves the Hono app over node:http via @hono/node-server. */
import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";

const port = Number(process.env.PORT ?? 8787);
const app = createApp();

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`@thenar/api listening on http://localhost:${info.port}`);
});
